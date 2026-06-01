import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { commonPrefixDelta } from "../core/delta.js";
import type { AgentAdapter, AgentLaunchOptions, ForkMeta, SessionRef, TerminalContext } from "../core/types.js";
import { claudeHome } from "../platform/paths.js";
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

  async detectCurrentSession(ctx: TerminalContext): Promise<SessionRef | null> {
    const envSessionId = readEnvSessionId(ctx.env);
    if (envSessionId) {
      return await sessionRefFromId(envSessionId, ctx.env.PWD);
    }

    const activeTranscriptPath = await findActiveClaudeTranscriptPath(ctx);
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
    const current = await this.detectCurrentSession(ctx);
    if (current && current.id !== meta.parentSession.id) {
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

async function findActiveClaudeTranscriptPath(ctx: TerminalContext): Promise<string | null> {
  if (ctx.terminal !== "iterm" || !ctx.paneId) {
    return null;
  }

  const tty = await findItermTty(ctx.paneId);
  if (!tty) {
    return null;
  }

  const processes = await findClaudeProcessesForTty(tty);
  for (const processInfo of processes) {
    const transcriptPath = await findOpenClaudeTranscriptPath(processInfo.pid);
    if (transcriptPath) {
      return transcriptPath;
    }
  }

  for (const processInfo of processes) {
    const cwd = await findProcessCwd(processInfo.pid);
    if (!cwd) {
      continue;
    }

    const transcriptPath = await findLatestTranscriptForCwd(cwd);
    if (transcriptPath) {
      return transcriptPath;
    }
  }

  return null;
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

async function findLatestTranscriptForCwd(cwd: string): Promise<string | null> {
  const paths = await listClaudeTranscriptPaths(projectDirForCwd(cwd));
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
    const summary = await readClaudeSessionSummary(entry.candidate).catch((): ClaudeSessionSummary => ({}));
    if (!summary.cwd || summary.cwd === cwd) {
      return entry.candidate;
    }
  }

  return null;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellWords(values: string[] = []): string {
  return values.map(shellQuote).join(" ");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
