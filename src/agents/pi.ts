import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { commonPrefixDelta } from "../core/delta.js";
import type { AgentAdapter, AgentDetectionOptions, AgentLaunchOptions, ForkMeta, SessionRef, TerminalContext } from "../core/types.js";
import { piHome } from "../platform/paths.js";
import { getFocusedGhosttyTty, getGhosttyTtys, isTtyPaneId } from "../platform/process.js";
import { runFile } from "../platform/shell.js";
import { readPiRenderedEvents } from "./piTranscript.js";

interface ProcessInfo {
  pid: number;
  command: string;
}

interface PiSessionSummary {
  sessionId?: string;
  cwd?: string;
  title?: string;
  parentSession?: string;
}

export class PiAdapter implements AgentAdapter {
  name = "pi" as const;

  async detectCurrentSession(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<SessionRef | null> {
    const envSessionId = readEnvSessionId(ctx.env);
    if (envSessionId) {
      return await sessionRefFromId(envSessionId, ctx.env.PWD, ctx.env);
    }

    const activeTranscriptPath = await findActivePiTranscriptPath(ctx, options);
    if (activeTranscriptPath) {
      return await sessionRefFromTranscriptPath(activeTranscriptPath);
    }

    return null;
  }

  async buildForkCommand(parent: SessionRef, options: AgentLaunchOptions = {}): Promise<string> {
    const cwd = parent.cwd ?? process.cwd();
    const source = parent.transcriptPath ?? parent.id;
    const sessionDir = parent.transcriptPath ? ` --session-dir ${shellQuote(path.dirname(parent.transcriptPath))}` : "";
    const flags = shellWords(options.flags);
    const flagSegment = flags ? ` ${flags}` : "";
    return `cd ${shellQuote(cwd)} && pi${flagSegment}${sessionDir} --fork ${shellQuote(source)}`;
  }

  async captureForkSnapshot(parent: SessionRef): Promise<Record<string, unknown>> {
    const parentSessionDir = parent.transcriptPath
      ? path.dirname(parent.transcriptPath)
      : parent.cwd
        ? sessionDirForCwd(parent.cwd)
        : sessionsRoot();

    return {
      parentSessionDir,
      preForkTranscriptPaths: await listPiTranscriptPaths(parentSessionDir),
    };
  }

  async resolveForkChild(meta: ForkMeta, ctx: TerminalContext): Promise<SessionRef | null> {
    const current = await this.detectCurrentSession(ctx, { strict: true });
    if (current && await sessionBelongsToFork(current, meta)) {
      return current;
    }

    const transcriptPath = await findNewTranscriptPath(meta);
    if (!transcriptPath) {
      return null;
    }

    return await sessionRefFromTranscriptPath(transcriptPath);
  }

  async renderDelta(parent: SessionRef, child: SessionRef): Promise<string> {
    if (!parent.transcriptPath) {
      throw new Error(`Parent Pi session ${parent.id} has no transcript path.`);
    }
    if (!child.transcriptPath) {
      throw new Error(`Child Pi session ${child.id} has no transcript path.`);
    }

    const [parentEvents, childEvents] = await Promise.all([
      readPiRenderedEvents(parent.transcriptPath),
      readPiRenderedEvents(child.transcriptPath),
    ]);

    return commonPrefixDelta(parentEvents, childEvents).join("\n\n");
  }
}

async function sessionRefFromId(sessionId: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<SessionRef> {
  const transcriptPath = await findTranscriptPathForSession(sessionId, cwd, env);
  if (!transcriptPath) {
    return {
      agent: "pi",
      id: sessionId,
      cwd,
    };
  }

  return await sessionRefFromTranscriptPath(transcriptPath);
}

async function sessionRefFromTranscriptPath(transcriptPath: string): Promise<SessionRef> {
  const id = sessionIdFromTranscriptPath(transcriptPath) ?? path.basename(transcriptPath, ".jsonl");
  const summary = await readPiSessionSummary(transcriptPath).catch((): PiSessionSummary => ({}));

  return {
    agent: "pi",
    id: summary.sessionId ?? id,
    cwd: summary.cwd,
    title: summary.title,
    transcriptPath,
  };
}

function readEnvSessionId(env: NodeJS.ProcessEnv): string | undefined {
  return env.PI_SESSION_ID ?? env.PI_CODING_AGENT_SESSION_ID;
}

async function findActivePiTranscriptPath(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<string | null> {
  if (ctx.terminal === "iterm" && ctx.paneId) {
    const tty = await findItermTty(ctx.paneId);
    if (!tty) return null;
    return findActivePiTranscriptForProcesses(await findPiProcessesForTty(tty), ctx.env);
  }

  if (ctx.terminal === "ghostty") {
    return findActivePiTranscriptForProcesses(await findPiProcessesInGhostty(ctx.paneId, options), ctx.env);
  }

  if (ctx.terminal === "tmux" && ctx.paneId) {
    const ttyRaw = await runFile("tmux", ["display-message", "-p", "-t", ctx.paneId, "#{pane_tty}"]).catch(() => "");
    const tty = ttyRaw.trim();
    if (tty && tty !== "??") {
      return findActivePiTranscriptForProcesses(await findPiProcessesForTty(tty), ctx.env);
    }
  }

  return null;
}

async function findActivePiTranscriptForProcesses(processes: ProcessInfo[], env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const processInfo of processes) {
    const transcriptPath = await findOpenPiTranscriptPath(processInfo.pid);
    if (transcriptPath) return transcriptPath;
  }

  for (const processInfo of processes) {
    const cwd = await findProcessCwd(processInfo.pid);
    if (!cwd) continue;
    const transcriptPath = await findLatestTranscriptForCwd(cwd, env);
    if (transcriptPath) return transcriptPath;
  }

  return null;
}

async function findPiProcessesInGhostty(paneId: string, options: AgentDetectionOptions = {}): Promise<ProcessInfo[]> {
  let ttys: Set<string>;
  if (isTtyPaneId(paneId)) {
    ttys = new Set([paneId]);
  } else {
    // ghostty-focused: scan only the focused TTY to avoid ambiguity with other agents.
    const focusedTty = await getFocusedGhosttyTty();
    if (focusedTty) {
      return findPiProcessesForTty(focusedTty);
    }
    if (options.strict) {
      return [];
    }
    ttys = await getGhosttyTtys();
  }
  if (ttys.size === 0) return [];
  const output = await runFile("ps", ["-ax", "-o", "pid=,tty=,command="]).catch(() => "");
  return output.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return [];
    const [, pidStr, tty, command] = m;
    if (!ttys.has(tty)) return [];
    const processInfo = { pid: Number(pidStr), command };
    return isPiProcess(command) ? [processInfo] : [];
  });
}

async function findItermTty(paneId: string): Promise<string | null> {
  const script = `
on run argv
  set target_pane_id to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is target_pane_id then
            return tty of s
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return ""
end run
`;

  const tty = await runFile("osascript", ["-e", script, paneId]).catch(() => "");
  return tty || null;
}

async function findPiProcessesForTty(tty: string): Promise<ProcessInfo[]> {
  const ttyName = path.basename(tty);
  const output = await runFile("ps", ["-t", ttyName, "-ww", "-o", "pid=", "-o", "command="]).catch(() => "");

  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return [];
    }

    const processInfo = {
      pid: Number(match[1]),
      command: match[2],
    };
    return isPiProcess(processInfo.command) ? [processInfo] : [];
  });
}

function isPiProcess(command: string): boolean {
  const tokens = command.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "").replace(/^-/, ""));
  if (tokens.some((token) => path.basename(token) === "pi")) {
    return true;
  }

  return command.includes("@earendil-works/pi-coding-agent") ||
    command.includes("/pi-coding-agent/");
}

async function findOpenPiTranscriptPath(pid: number): Promise<string | null> {
  const output = await runFile("lsof", ["-Fn", "-p", String(pid)]).catch(() => "");
  const paths = output.split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter((candidate) => candidate.endsWith(".jsonl"));

  const piPaths: string[] = [];
  for (const candidate of paths) {
    if (await isPiTranscriptPath(candidate)) {
      piPaths.push(candidate);
    }
  }

  return await newestExistingPath(piPaths);
}

async function findProcessCwd(pid: number): Promise<string | null> {
  const output = await runFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => "");
  return output.split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) ?? null;
}

async function findLatestTranscriptForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const paths = await listPiTranscriptPathsForCwd(cwd, env);
  if (paths.length === 0) {
    return null;
  }

  const stats = await Promise.all(paths.map(async (candidate) => {
    return {
      candidate,
      stat: await fs.stat(candidate).catch(() => null),
    };
  }));

  const newest = stats
    .filter((entry) => entry.stat !== null)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 25);

  for (const entry of newest) {
    const summary = await readPiSessionSummary(entry.candidate).catch((): PiSessionSummary => ({}));
    if (!summary.cwd || path.resolve(summary.cwd) === path.resolve(cwd)) {
      return entry.candidate;
    }
  }

  return null;
}

async function findTranscriptPathForSession(sessionId: string, cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (sessionId.endsWith(".jsonl") && await pathExists(sessionId)) {
    return sessionId;
  }

  const cwdPaths = cwd ? await listPiTranscriptPathsForCwd(cwd, env) : [];
  const allPaths = await listPiTranscriptPaths(sessionsRoot(env));
  const searchPaths = [...new Set([...cwdPaths, ...allPaths])];

  const exact = searchPaths.find((candidate) => sessionIdFromTranscriptPath(candidate) === sessionId);
  if (exact) {
    return exact;
  }

  return searchPaths.find((candidate) => sessionIdFromTranscriptPath(candidate)?.startsWith(sessionId)) ?? null;
}

async function findNewTranscriptPath(meta: ForkMeta): Promise<string | null> {
  const before = new Set(readStringArray(meta.snapshot.preForkTranscriptPaths));
  const parentSessionDir = typeof meta.snapshot.parentSessionDir === "string"
    ? meta.snapshot.parentSessionDir
    : meta.parentSession.transcriptPath
      ? path.dirname(meta.parentSession.transcriptPath)
      : sessionsRoot();

  const allPaths = await listPiTranscriptPaths(parentSessionDir);
  const candidates = allPaths.filter((candidate) => {
    return candidate !== meta.parentSession.transcriptPath && !before.has(candidate);
  });

  if (candidates.length !== 1) {
    return null;
  }

  return await newestExistingPath(candidates);
}

async function newestExistingPath(paths: string[]): Promise<string | null> {
  const stats = await Promise.all(paths.map(async (candidate) => {
    return {
      candidate,
      stat: await fs.stat(candidate).catch(() => null),
    };
  }));

  return stats
    .filter((entry) => entry.stat !== null)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))[0]?.candidate ?? null;
}

async function readPiSessionSummary(transcriptPath: string): Promise<PiSessionSummary> {
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const summary: PiSessionSummary = {};
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isObject(record)) {
      continue;
    }
    if (record.type === "session") {
      if (typeof record.id === "string") {
        summary.sessionId = record.id;
      }
      if (typeof record.cwd === "string") {
        summary.cwd = record.cwd;
      }
      if (typeof record.parentSession === "string") {
        summary.parentSession = record.parentSession;
      }
    }
    if (record.type === "session_info" && typeof record.name === "string") {
      summary.title = record.name;
    }
  }

  return summary;
}

async function isPiTranscriptPath(candidate: string): Promise<boolean> {
  if (!candidate.endsWith(".jsonl")) {
    return false;
  }
  if (candidate.includes(`${path.sep}.pi${path.sep}agent${path.sep}sessions${path.sep}`)) {
    return true;
  }

  const summary = await readPiSessionSummary(candidate).catch((): PiSessionSummary => ({}));
  return summary.sessionId !== undefined;
}

async function listPiTranscriptPathsForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const configuredSessionDir = env.PI_CODING_AGENT_SESSION_DIR;
  if (configuredSessionDir) {
    return await listPiTranscriptPaths(configuredSessionDir);
  }

  return await listPiTranscriptPaths(sessionDirForCwd(cwd, env));
}

async function listPiTranscriptPaths(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listPiTranscriptPaths(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      return [fullPath];
    }
    return [];
  }));

  return files.flat().sort();
}

function sessionDirForCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const safePath = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(sessionsRoot(env), safePath);
}

function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_SESSION_DIR ?? path.join(piHome(env), "sessions");
}

function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const match = path.basename(transcriptPath).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] ?? null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function sessionBelongsToFork(session: SessionRef, meta: ForkMeta): Promise<boolean> {
  if (session.id === meta.parentSession.id) {
    return false;
  }
  if (!session.transcriptPath) {
    return false;
  }
  if (session.transcriptPath === meta.parentSession.transcriptPath) {
    return false;
  }

  const before = new Set(readStringArray(meta.snapshot.preForkTranscriptPaths));
  if (before.has(session.transcriptPath)) {
    return false;
  }

  const summary = await readPiSessionSummary(session.transcriptPath).catch((): PiSessionSummary => ({}));
  return !summary.parentSession || summary.parentSession === meta.parentSession.id;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellWords(values: string[] = []): string {
  return values.map(shellQuote).join(" ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
