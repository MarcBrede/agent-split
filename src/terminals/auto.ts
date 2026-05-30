import type { TerminalContext } from "../core/types.js";
import { detectFocusedItermContext } from "./iterm.js";

export interface DetectTerminalOptions {
  env?: NodeJS.ProcessEnv;
  focused?: boolean;
}

export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalContext | null {
  if (env.TMUX_PANE) {
    return { terminal: "tmux", paneId: env.TMUX_PANE, env };
  }

  if (env.WEZTERM_PANE) {
    return { terminal: "wezterm", paneId: env.WEZTERM_PANE, env };
  }

  if (env.KITTY_WINDOW_ID) {
    return { terminal: "kitty", paneId: env.KITTY_WINDOW_ID, env };
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
    return await detectFocusedItermContext(env) ?? detectTerminal(env);
  }

  return detectTerminal(env) ?? await detectFocusedItermContext(env);
}
