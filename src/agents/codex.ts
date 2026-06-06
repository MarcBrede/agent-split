import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { commonPrefixDelta } from "../core/delta.js";
import type { AgentAdapter, AgentDetectionOptions, AgentLaunchOptions, ForkMeta, SessionRef, TerminalContext } from "../core/types.js";
import { codexHome } from "../platform/paths.js";
import { getFocusedGhosttyTty, getGhosttyTtys, getProcessStartTimeMs, isTtyPaneId } from "../platform/process.js";
import { runFile } from "../platform/shell.js";
import { readCodexRenderedEvents } from "./codexTranscript.js";

interface CodexThreadRow {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string;
}

interface SnapshotMatch {
  path: string;
  mtimeMs: number;
}

export class CodexAdapter implements AgentAdapter {
  name = "codex" as const;

  async detectCurrentSession(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<SessionRef | null> {
    const sessionId = ctx.env.CODEX_THREAD_ID
      ?? (ctx.terminal === "ghostty"
        ? await findSessionIdFromGhosttyProcess(ctx.paneId, options)
        : ctx.terminal === "tmux"
          ? await findSessionIdFromTmuxPane(ctx.paneId) ?? await findSessionIdFromShellSnapshot(ctx, options)
          : await findSessionIdFromShellSnapshot(ctx, options));
    if (!sessionId) {
      return null;
    }

    const row = await findThreadRow(sessionId);
    if (!row) {
      return {
        agent: this.name,
        id: sessionId,
      };
    }

    return {
      agent: this.name,
      id: row.id,
      cwd: row.cwd,
      title: row.title,
      transcriptPath: row.rollout_path,
    };
  }

  async buildForkCommand(parent: SessionRef, options: AgentLaunchOptions = {}): Promise<string> {
    const cwd = parent.cwd ?? process.cwd();
    const flags = shellWords(options.flags);
    const flagSegment = flags ? ` ${flags}` : "";
    return `cd ${shellQuote(cwd)} && CODEX_FORK_PARENT=${shellQuote(parent.id)} codex fork --cd ${shellQuote(cwd)}${flagSegment} ${shellQuote(parent.id)}`;
  }

  async captureForkSnapshot(_parent: SessionRef): Promise<Record<string, unknown>> {
    return {
      preForkTranscriptPaths: await listCodexTranscriptPaths(),
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

    const sessionId = sessionIdFromTranscriptPath(transcriptPath);
    if (!sessionId) {
      return {
        agent: this.name,
        id: path.basename(transcriptPath, ".jsonl"),
        transcriptPath,
      };
    }

    const row = await findThreadRow(sessionId);
    if (row) {
      return {
        agent: this.name,
        id: row.id,
        cwd: row.cwd,
        title: row.title,
        transcriptPath: row.rollout_path,
      };
    }

    return {
      agent: this.name,
      id: sessionId,
      transcriptPath,
    };
  }

  async renderDelta(parent: SessionRef, child: SessionRef): Promise<string> {
    if (!parent.transcriptPath) {
      throw new Error(`Parent Codex session ${parent.id} has no transcript path.`);
    }
    if (!child.transcriptPath) {
      throw new Error(`Child Codex session ${child.id} has no transcript path.`);
    }

    const [parentEvents, childEvents] = await Promise.all([
      readCodexRenderedEvents(parent.transcriptPath),
      readCodexRenderedEvents(child.transcriptPath),
    ]);

    return commonPrefixDelta(parentEvents, childEvents).join("\n\n");
  }
}

async function findSessionIdFromShellSnapshot(ctx: TerminalContext, options: AgentDetectionOptions = {}): Promise<string | null> {
  if (!ctx.paneId) {
    return null;
  }

  const snapshotDir = path.join(codexHome(), "shell_snapshots");
  let entries: string[];
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return null;
  }

  const matches: SnapshotMatch[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sh")) {
      continue;
    }

    const fullPath = path.join(snapshotDir, entry);
    const [stat, contents] = await Promise.all([
      fs.stat(fullPath).catch(() => null),
      fs.readFile(fullPath, "utf8").catch(() => ""),
    ]);

    if (!stat || !snapshotMatchesTerminal(contents, ctx, options)) {
      continue;
    }

    matches.push({ path: fullPath, mtimeMs: stat.mtimeMs });
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = matches[0];
  if (!latest) {
    return null;
  }

  return path.basename(latest.path).split(".")[0] || null;
}

function snapshotMatchesTerminal(contents: string, ctx: TerminalContext, options: AgentDetectionOptions = {}): boolean {
  switch (ctx.terminal) {
    case "iterm":
      return contents.includes(`:${ctx.paneId}`) || contents.includes(`ITERM_SESSION_ID=${ctx.paneId}`);
    case "tmux":
      return contents.includes(`TMUX_PANE=${ctx.paneId}`) || contents.includes(`export TMUX_PANE=${ctx.paneId}`);
    case "wezterm":
      return contents.includes(`WEZTERM_PANE=${ctx.paneId}`) || contents.includes(`export WEZTERM_PANE=${ctx.paneId}`);
    case "kitty":
      return contents.includes(`KITTY_WINDOW_ID=${ctx.paneId}`) || contents.includes(`export KITTY_WINDOW_ID=${ctx.paneId}`);
    case "ghostty":
      // Prefer exact pane match via AGENT_SPLIT_PANE_ID when available (set in forked panes)
      if (ctx.paneId && ctx.paneId !== "ghostty-focused") {
        return contents.includes(`AGENT_SPLIT_PANE_ID=${ctx.paneId}`);
      }
      if (options.strict) {
        return false;
      }
      return contents.includes("TERM_PROGRAM=ghostty");
    default:
      return false;
  }
}

async function findThreadRow(sessionId: string): Promise<CodexThreadRow | null> {
  const db = path.join(codexHome(), "state_5.sqlite");
  try {
    await fs.access(db);
  } catch {
    return null;
  }

  const sql = `select id, rollout_path, cwd, title from threads where id = '${escapeSql(sessionId)}' limit 1;`;

  let output: string;
  try {
    output = await runFile("sqlite3", ["-json", db, sql]);
  } catch {
    return null;
  }

  if (!output.trim()) {
    return null;
  }

  const rows = JSON.parse(output) as CodexThreadRow[];
  return rows[0] ?? null;
}

async function findSessionIdFromTmuxPane(paneId: string): Promise<string | null> {
  const ttyRaw = await runFile("tmux", ["display-message", "-p", "-t", paneId, "#{pane_tty}"]).catch(() => "");
  const tty = path.basename(ttyRaw.trim()); // e.g. /dev/ttys014 → ttys014
  if (!tty || tty === "??") return null;
  return findSessionIdFromProcessesOnTtys(new Set([tty]));
}

async function findSessionIdFromProcessesOnTtys(ttys: Set<string>): Promise<string | null> {
  const output = await runFile("ps", ["-ax", "-o", "pid=,tty=,command="]).catch(() => "");
  const pids = output.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return [];
    const [, pidStr, tty, command] = m;
    if (!ttys.has(tty)) return [];
    const parts = command.trim().split(/\s+/);
    const exe = parts[0] ?? "";
    if (path.basename(exe) !== "codex") return [];
    // Exclude MCP server mode — it's spawned by Claude Code on the same TTY, not a user session
    if (parts[1] === "mcp-server") return [];
    return [Number(pidStr)];
  });

  for (const pid of pids) {
    const lsofOut = await runFile("lsof", ["-Fn", "-p", String(pid)]).catch(() => "");
    const jsonlPath = lsofOut.split("\n")
      .filter((l) => l.startsWith("n") && l.endsWith(".jsonl"))
      .map((l) => l.slice(1))[0];
    if (jsonlPath) return sessionIdFromPath(jsonlPath);
  }

  for (const pid of pids) {
    const row = await findThreadRowByProcessInfo(pid);
    if (row) return row.id;
  }

  return null;
}

async function findSessionIdFromGhosttyProcess(paneId: string, options: AgentDetectionOptions = {}): Promise<string | null> {
  const isTty = isTtyPaneId(paneId);

  if (isTty) {
    return findSessionIdFromProcessesOnTtys(new Set([paneId]));
  }

  // ghostty-focused: scan only the focused TTY to avoid ambiguity with other agents.
  // If the focused pane doesn't have codex, we don't want to surface a background session.
  const focusedTty = await getFocusedGhosttyTty();
  if (focusedTty) {
    return findSessionIdFromProcessesOnTtys(new Set([focusedTty]));
  }

  if (options.strict) {
    return null;
  }

  // Can't determine focused TTY — broad scan across all Ghostty TTYs
  const ttys = await getGhosttyTtys();
  if (ttys.size > 0) {
    const result = await findSessionIdFromProcessesOnTtys(ttys);
    if (result) return result;
  }

  // Last resort when no TTY context at all: most recently active thread in the DB
  const row = await findMostRecentThreadRow();
  return row?.id ?? null;
}

async function findMostRecentThreadRow(): Promise<CodexThreadRow | null> {
  const db = path.join(codexHome(), "state_5.sqlite");
  try { await fs.access(db); } catch { return null; }
  const sql = `select id, rollout_path, cwd, title from threads where archived = 0 order by updated_at_ms desc limit 1;`;
  const output = await runFile("sqlite3", ["-json", db, sql]).catch(() => "");
  if (!output.trim()) return null;
  const rows = JSON.parse(output) as CodexThreadRow[];
  return rows[0] ?? null;
}

async function findThreadRowByProcessInfo(pid: number): Promise<CodexThreadRow | null> {
  const db = path.join(codexHome(), "state_5.sqlite");
  try { await fs.access(db); } catch { return null; }

  const [cwd, startTimeMs] = await Promise.all([
    findProcessCwd(pid),
    getProcessStartTimeMs(pid),
  ]);
  if (!cwd) return null;

  // First: find thread created when this process started (fresh session)
  if (startTimeMs !== null) {
    const sqlFresh = `select id, rollout_path, cwd, title from threads where cwd = '${escapeSql(cwd)}' and archived = 0 and created_at_ms >= ${startTimeMs - 5000} and created_at_ms <= ${startTimeMs + 60000} order by created_at_ms desc limit 1;`;
    const freshOut = await runFile("sqlite3", ["-json", db, sqlFresh]).catch(() => "");
    if (freshOut.trim()) {
      const rows = JSON.parse(freshOut) as CodexThreadRow[];
      if (rows[0]) return rows[0];
    }
  }

  // Fallback: most recently active thread with matching cwd
  const sqlRecent = `select id, rollout_path, cwd, title from threads where cwd = '${escapeSql(cwd)}' and archived = 0 order by updated_at_ms desc limit 1;`;
  const recentOut = await runFile("sqlite3", ["-json", db, sqlRecent]).catch(() => "");
  if (!recentOut.trim()) return null;
  const rows = JSON.parse(recentOut) as CodexThreadRow[];
  return rows[0] ?? null;
}

async function findProcessCwd(pid: number): Promise<string | null> {
  const output = await runFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => "");
  return output.split("\n").find((line) => line.startsWith("n"))?.slice(1) ?? null;
}

function sessionIdFromPath(filePath: string): string | null {
  // Codex JSONL filenames: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl or <uuid>.jsonl
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] ?? null;
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellWords(values: string[] = []): string {
  return values.map(shellQuote).join(" ");
}

async function listCodexTranscriptPaths(): Promise<string[]> {
  const sessionsDir = path.join(codexHome(), "sessions");
  return (await listJsonlFiles(sessionsDir)).sort();
}

async function findNewTranscriptPath(meta: ForkMeta): Promise<string | null> {
  const before = new Set(readStringArray(meta.snapshot.preForkTranscriptPaths));
  const allPaths = await listCodexTranscriptPaths();
  const candidates = allPaths.filter((candidate) => {
    return candidate !== meta.parentSession.transcriptPath && !before.has(candidate);
  });

  if (candidates.length !== 1) {
    return null;
  }

  const stats = await Promise.all(candidates.map(async (candidate) => {
    return {
      candidate,
      stat: await fs.stat(candidate).catch(() => null),
    };
  }));

  return stats
    .filter((entry) => entry.stat !== null)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))[0]?.candidate ?? null;
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const match = path.basename(transcriptPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return match?.[1] ?? null;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJsonlFiles(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      return [fullPath];
    }
    return [];
  }));

  return files.flat();
}
