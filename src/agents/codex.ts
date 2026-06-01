import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { commonPrefixDelta } from "../core/delta.js";
import type { AgentAdapter, AgentLaunchOptions, ForkMeta, SessionRef, TerminalContext } from "../core/types.js";
import { codexHome } from "../platform/paths.js";
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

  async detectCurrentSession(ctx: TerminalContext): Promise<SessionRef | null> {
    const sessionId = ctx.env.CODEX_THREAD_ID ?? await findSessionIdFromShellSnapshot(ctx);
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
    const current = await this.detectCurrentSession(ctx);
    if (current && current.id !== meta.parentSession.id) {
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

async function findSessionIdFromShellSnapshot(ctx: TerminalContext): Promise<string | null> {
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

    if (!stat || !snapshotMatchesTerminal(contents, ctx)) {
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

function snapshotMatchesTerminal(contents: string, ctx: TerminalContext): boolean {
  switch (ctx.terminal) {
    case "iterm":
      return contents.includes(`:${ctx.paneId}`) || contents.includes(`ITERM_SESSION_ID=${ctx.paneId}`);
    case "tmux":
      return contents.includes(`TMUX_PANE=${ctx.paneId}`) || contents.includes(`export TMUX_PANE=${ctx.paneId}`);
    case "wezterm":
      return contents.includes(`WEZTERM_PANE=${ctx.paneId}`) || contents.includes(`export WEZTERM_PANE=${ctx.paneId}`);
    case "kitty":
      return contents.includes(`KITTY_WINDOW_ID=${ctx.paneId}`) || contents.includes(`export KITTY_WINDOW_ID=${ctx.paneId}`);
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

  if (candidates.length === 0) {
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
