import fs from "node:fs/promises";
import { runFile } from "./shell.js";

export async function getProcessStartTimeMs(pid: number): Promise<number | null> {
  const output = await runFile("ps", ["-p", String(pid), "-o", "lstart="]).catch(() => "");
  const trimmed = output.trim();
  if (!trimmed) return null;
  const timestamp = Date.parse(trimmed);
  return isNaN(timestamp) ? null : timestamp;
}

export async function getSelfTty(): Promise<string | null> {
  const out = await runFile("ps", ["-p", String(process.pid), "-o", "tty="]).catch(() => "");
  const tty = out.trim();
  return tty && tty !== "??" ? tty : null;
}

export function isTtyPaneId(paneId: string): boolean {
  return /^ttys?\d+$/.test(paneId);
}

export async function getGhosttyTtys(): Promise<Set<string>> {
  const pidStr = await runFile("pgrep", ["-x", "ghostty"]).catch(() => "");
  const ghosttyPids = new Set(pidStr.split("\n").filter(Boolean).map(Number));
  if (ghosttyPids.size === 0) return new Set();

  const allProcs = await runFile("ps", ["-ax", "-o", "pid=,ppid=,tty="]).catch(() => "");
  const rows = allProcs.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3] }] : [];
  });

  const ttys = new Set<string>();

  // Direct children of Ghostty (non-tmux panes)
  for (const { ppid, tty } of rows) {
    if (ghosttyPids.has(ppid) && tty !== "??") {
      ttys.add(tty);
    }
  }

  // Always include tmux pane TTYs — Ghostty may use tmux integration
  // alongside regular panes, so we can't use direct-children as an early exit.
  const tmuxPidStr = await runFile("pgrep", ["-x", "tmux"]).catch(() => "");
  const tmuxPids = new Set(tmuxPidStr.split("\n").filter(Boolean).map(Number));
  for (const { ppid, tty } of rows) {
    if (tmuxPids.has(ppid) && tty !== "??") {
      ttys.add(tty);
    }
  }

  return ttys;
}

// Returns the TTY of the currently focused Ghostty pane by finding the most
// recently active TTY device among all Ghostty TTYs. This works for both
// direct Ghostty panes and tmux-integrated panes because the pane the user
// last typed in will have the most recent /dev/<tty> mtime.
export async function getFocusedGhosttyTty(): Promise<string | null> {
  const allTtys = await getGhosttyTtys();
  if (allTtys.size === 0) return null;

  const stats = await Promise.all([...allTtys].map(async (tty) => ({
    tty,
    mtime: await fs.stat(`/dev/${tty}`).then((s) => s.mtimeMs).catch(() => 0),
  })));
  return stats.sort((a, b) => b.mtime - a.mtime)[0]?.tty ?? null;
}
