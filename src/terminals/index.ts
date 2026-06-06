import type { TerminalAdapter, TerminalContext } from "../core/types.js";
import { GhosttyAdapter } from "./ghostty.js";
import { ItermAdapter } from "./iterm.js";
import { TmuxAdapter } from "./tmux.js";

const adapters: TerminalAdapter[] = [new ItermAdapter(), new GhosttyAdapter(), new TmuxAdapter()];

export function getTerminalAdapter(ctx: TerminalContext): TerminalAdapter | null {
  return adapters.find((adapter) => adapter.name === ctx.terminal) ?? null;
}