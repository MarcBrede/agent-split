import type { TerminalContext } from "../core/types.js";
import { getSelfTty, isTtyPaneId } from "../platform/process.js";
import { detectFocusedGhosttyContext } from "./ghostty.js";
import { detectFocusedItermContext } from "./iterm.js";

export interface DetectTerminalOptions {
  env?: NodeJS.ProcessEnv;
  focused?: boolean;
}

export async function detectTerminal(env: NodeJS.ProcessEnv = process.env): Promise<TerminalContext | null> {
  if (env.TMUX_PANE) {
    return { terminal: "tmux", paneId: env.TMUX_PANE, env };
  }

  if (env.WEZTERM_PANE) {
    return { terminal: "wezterm", paneId: env.WEZTERM_PANE, env };
  }

  if (env.KITTY_WINDOW_ID) {
    return { terminal: "kitty", paneId: env.KITTY_WINDOW_ID, env };
  }

  if (env.TERM_PROGRAM === "ghostty") {
    const selfTty = await getSelfTty();
    const paneId = env.AGENT_SPLIT_PANE_ID ?? selfTty ?? "ghostty-focused";
    return { terminal: "ghostty", paneId, env };
  }

  if (env.ITERM_SESSION_ID) {
    const paneId = env.ITERM_SESSION_ID.includes(":")
      ? env.ITERM_SESSION_ID.split(":").at(-1)
      : env.ITERM_SESSION_ID;
    if (paneId) {
      return { terminal: "iterm", paneId, env };
    }
  }

  return null;
}

export async function detectTerminalContext(
  options: DetectTerminalOptions = {},
): Promise<TerminalContext | null> {
  const env = options.env ?? process.env;

  if (options.focused) {
    return await detectFocusedItermContext(env)
      ?? await detectFocusedGhosttyContext(env)
      ?? await detectTerminal(env);
  }

  return await detectTerminal(env)
    ?? await detectFocusedItermContext(env)
    ?? await detectFocusedGhosttyContext(env);
}

export { isTtyPaneId };
