import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { commonPrefixDelta } from "../core/delta.js";
import type { AgentAdapter, AgentDetectionOptions, AgentLaunchOptions, ForkMeta, SessionRef, TerminalContext } from "../core/types.js";
import { claudeHome } from "../platform/paths.js";
import { getFocusedGhosttyTty, getGhosttyTtys, getProcessStartTimeMs, isTtyPaneId } from "../platform/process.js";
import { runFile } from "../platform/shell.js";
import { readClaudeRenderedEvents } from "./claudeTranscript.js";

interface ProcessInfo {
  pid: number;
  command: string;
}

interface ClaudeSessionSummary {
  sessionId?: string;
  cwd?: string;
  title?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  name = "claude" as const;

  async detectCurrentSession(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<SessionRef | null> {
    const envSessionId = readEnvSessionId(ctx.env);
    if (envSessionId) {
      return await sessionRefFromId(envSessionId, ctx.env.PWD);
    }

    const activeTranscriptPath = await findActiveClaudeTranscriptPath(ctx, options);
    if (activeTranscriptPath) {
      return await sessionRefFromTranscriptPath(activeTranscriptPath);
    }

    return null;
  }

  async buildForkCommand(parent: SessionRef, options: AgentLaunchOptions = {}): Promise<string> {
    const cwd = parent.cwd ?? process.cwd();
    const flags = shellWords(options.flags);
    const flagSegment = flags ? ` ${flags}` : "";
    return `cd ${shellQuote(cwd)} && claude${flagSegment} --resume ${shellQuote(parent.id)} --fork-session`;
  }

  async captureForkSnapshot(parent: SessionRef): Promise<Record<string, unknown>> {
    const parentProjectDir = parent.transcriptPath ? path.dirname(parent.transcriptPath) : null;
    return {
      parentProjectDir,
      preForkTranscriptPaths: await listClaudeTranscriptPaths(parentProjectDir ?? projectsDir()),
    };
  }

  async resolveForkChild(meta: ForkMeta, ctx: TerminalContext): Promise<SessionRef | null> {
    const current = await this.detectCurrentSession(ctx, { strict: true });
    if (current && sessionBelongsToFork(current, meta)) {
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
      throw new Error(`Parent Claude session ${parent.id} has no transcript path.`);
    }
    if (!child.transcriptPath) {
      throw new Error(`Child Claude session ${child.id} has no transcript path.`);
    }

    const [parentEvents, childEvents] = await Promise.all([
      readClaudeRenderedEvents(parent.transcriptPath),
      readClaudeRenderedEvents(child.transcriptPath),
    ]);

    return commonPrefixDelta(parentEvents, childEvents).join("\n\n");
  }
}

async function sessionRefFromId(sessionId: string, cwd?: string): Promise<SessionRef> {
  const transcriptPath = await findTranscriptPathForSession(sessionId, cwd);
  if (!transcriptPath) {
    return {
      agent: "claude",
      id: sessionId,
      cwd,
    };
  }

  return await sessionRefFromTranscriptPath(transcriptPath);
}

async function sessionRefFromTranscriptPath(transcriptPath: string): Promise<SessionRef> {
  const id = sessionIdFromTranscriptPath(transcriptPath) ?? path.basename(transcriptPath, ".jsonl");
  const summary = await readClaudeSessionSummary(transcriptPath).catch((): ClaudeSessionSummary => ({}));

  return {
    agent: "claude",
    id: summary.sessionId ?? id,
    cwd: summary.cwd,
    title: summary.title,
    transcriptPath,
  };
}

function readEnvSessionId(env: NodeJS.ProcessEnv): string | undefined {
  return env.CLAUDE_SESSION_ID ??
    env.CLAUDE_CODE_SESSION_ID ??
    env.ANTHROPIC_SESSION_ID;
}

async function findActiveClaudeTranscriptPath(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<string | null> {
  if (ctx.terminal === "iterm" && ctx.paneId) {
    const tty = await findItermTty(ctx.paneId);
    if (!tty) return null;
    return findActiveClaudeTranscriptForProcesses(await findClaudeProcessesForTty(tty));
  }

  if (ctx.terminal === "ghostty") {
    return findActiveClaudeTranscriptForProcesses(await findClaudeProcessesInGhostty(ctx.paneId, options));
  }

  if (ctx.terminal === "tmux" && ctx.paneId) {
    const ttyRaw = await runFile("tmux", ["display-message", "-p", "-t", ctx.paneId, "#{pane_tty}"]).catch(() => "");
    const tty = ttyRaw.trim();
    if (tty && tty !== "??") {
      return findActiveClaudeTranscriptForProcesses(await findClaudeProcessesForTty(tty));
    }
  }

  return null;
}

async function findActiveClaudeTranscriptForProcesses(processes: ProcessInfo[]): Promise<string | null> {
  for (const processInfo of processes) {
    const transcriptPath = await findOpenClaudeTranscriptPath(processInfo.pid);
    if (transcriptPath) return transcriptPath;
  }

  for (const processInfo of processes) {
    const transcriptPath = await findTranscriptByProcessInfo(processInfo);
    if (transcriptPath) return transcriptPath;
  }

  return null;
}

async function findTranscriptByProcessInfo(processInfo: ProcessInfo): Promise<string | null> {
  // For resumed sessions, --resume <session-id> tells us exactly which session
  const resumeId = parseResumeSessionId(processInfo.command);
  if (resumeId) {
    const transcriptPath = await findTranscriptPathForSession(resumeId);
    if (transcriptPath) return transcriptPath;
  }

  // For fresh sessions, find JSONL created close to when the process started
  const startTimeMs = await getProcessStartTimeMs(processInfo.pid);
  if (startTimeMs !== null) {
    return findTranscriptCreatedNear(startTimeMs);
  }

  return null;
}

function parseResumeSessionId(command: string): string | null {
  const match = command.match(/--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return match?.[1] ?? null;
}

async function findTranscriptCreatedNear(startTimeMs: number): Promise<string | null> {
  // Search all projects — process cwd (from lsof) may not match session cwd since Claude cds around
  const paths = await listClaudeTranscriptPaths(projectsDir());
  if (paths.length === 0) return null;

  const stats = await Promise.all(paths.map(async (candidate) => ({
    candidate,
    stat: await fs.stat(candidate).catch(() => null),
  })));

  // Fresh session: JSONL is created within ~60s of process start (5s pre-tolerance for clock skew)
  const candidates = stats
    .filter((entry) => {
      const birthtime = entry.stat?.birthtimeMs ?? 0;
      return birthtime >= startTimeMs - 5000 && birthtime <= startTimeMs + 60000;
    })
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0));

  return candidates[0]?.candidate ?? null;
}

async function findClaudeProcessesInGhostty(paneId: string, options: AgentDetectionOptions = {}): Promise<ProcessInfo[]> {
  let ttys: Set<string>;
  if (isTtyPaneId(paneId)) {
    ttys = new Set([paneId]);
  } else {
    // ghostty-focused: scan only the focused TTY to avoid ambiguity with other agents.
    const focusedTty = await getFocusedGhosttyTty();
    if (focusedTty) {
      return findClaudeProcessesForTty(focusedTty);
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
    return isClaudeProcess(command) ? [processInfo] : [];
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

async function findClaudeProcessesForTty(tty: string): Promise<ProcessInfo[]> {
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
    return isClaudeProcess(processInfo.command) ? [processInfo] : [];
  });
}

function isClaudeProcess(command: string): boolean {
  const executable = command.trim().split(/\s+/)[0]?.replace(/^-/, "");
  return executable ? path.basename(executable) === "claude" : false;
}

async function findOpenClaudeTranscriptPath(pid: number): Promise<string | null> {
  const output = await runFile("lsof", ["-Fn", "-p", String(pid)]).catch(() => "");
  const paths = output.split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .filter(isClaudeTranscriptPath);

  return await newestExistingPath(paths);
}

async function findProcessCwd(pid: number): Promise<string | null> {
  const output = await runFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => "");
  return output.split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1) ?? null;
}

async function findTranscriptPathForSession(sessionId: string, cwd?: string): Promise<string | null> {
  if (cwd) {
    const cwdPath = path.join(projectDirForCwd(cwd), `${sessionId}.jsonl`);
    if (await pathExists(cwdPath)) {
      return cwdPath;
    }
  }

  const paths = await listClaudeTranscriptPaths(projectsDir());
  return paths.find((candidate) => sessionIdFromTranscriptPath(candidate) === sessionId) ?? null;
}

async function findNewTranscriptPath(meta: ForkMeta): Promise<string | null> {
  const before = new Set(readStringArray(meta.snapshot.preForkTranscriptPaths));
  const parentProjectDir = typeof meta.snapshot.parentProjectDir === "string"
    ? meta.snapshot.parentProjectDir
    : null;
  const searchDir = parentProjectDir ?? projectsDir();
  const allPaths = await listClaudeTranscriptPaths(searchDir);
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

async function readClaudeSessionSummary(transcriptPath: string): Promise<ClaudeSessionSummary> {
  const stream = createReadStream(transcriptPath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const summary: ClaudeSessionSummary = {};
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
    if (typeof record.sessionId === "string") {
      summary.sessionId = record.sessionId;
    }
    if (typeof record.cwd === "string") {
      summary.cwd = record.cwd;
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      summary.title = record.aiTitle;
    }
  }

  return summary;
}

async function listClaudeTranscriptPaths(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listClaudeTranscriptPaths(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      return [fullPath];
    }
    return [];
  }));

  return files.flat();
}

function isClaudeTranscriptPath(filePath: string): boolean {
  return filePath.startsWith(`${projectsDir()}${path.sep}`) && filePath.endsWith(".jsonl");
}

function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const match = path.basename(transcriptPath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] ?? null;
}

function projectDirForCwd(cwd: string): string {
  return path.join(projectsDir(), encodeClaudeProjectDir(cwd));
}

function projectsDir(): string {
  return path.join(claudeHome(), "projects");
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sessionBelongsToFork(session: SessionRef, meta: ForkMeta): boolean {
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
  return !before.has(session.transcriptPath);
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
