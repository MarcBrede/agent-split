import type { TerminalAdapter, TerminalContext } from "../core/types.js";
import { ItermAdapter } from "./iterm.js";

const adapters: TerminalAdapter[] = [new ItermAdapter()];

export function getTerminalAdapter(ctx: TerminalContext): TerminalAdapter | null {
  return adapters.find((adapter) => adapter.name === ctx.terminal) ?? null;
}
