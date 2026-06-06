import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchResult, LaunchSiblingOptions, TerminalAdapter, TerminalContext } from "../core/types.js";
import { getFocusedGhosttyTty } from "../platform/process.js";
import { runFile } from "../platform/shell.js";

export async function detectFocusedGhosttyContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalContext | null> {
  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  if frontApp is "Ghostty" then
    return "ghostty"
  else
    return ""
  end if
end tell
`;
  try {
    const result = await runFile("osascript", ["-e", script]);
    if (result !== "ghostty") return null;
    const focusedTty = await getFocusedGhosttyTty();
    return { terminal: "ghostty", paneId: env.AGENT_SPLIT_PANE_ID ?? focusedTty ?? "ghostty-focused", env };
  } catch {
    return null;
  }
}

export class GhosttyAdapter implements TerminalAdapter {
  name = "ghostty" as const;

  async launchSibling(
    _parent: TerminalContext,
    command: string,
    options: LaunchSiblingOptions = {},
  ): Promise<LaunchResult> {
    const orientation = options.orientation ?? "horizontal";
    // horizontal = side-by-side = Cmd+D (new_split:right, Ghostty default)
    // vertical   = stacked      = Cmd+Shift+D (new_split:down, Ghostty default)
    const splitKeystroke = orientation === "vertical"
      ? `keystroke "d" using {command down, shift down}`
      : `keystroke "d" using command down`;

    const paneId = `ghostty-${randomUUID()}`;

    // Source (not bash) the script so AGENT_SPLIT_PANE_ID stays in the pane's shell,
    // allowing `agent-split merge` to find this fork's metadata later.
    const tmpFile = path.join(os.tmpdir(), `agent-split-${paneId}.sh`);
    const quotedTmpFile = shellQuote(tmpFile);
    await writeFile(
      tmpFile,
      `export AGENT_SPLIT_PANE_ID=${shellQuote(paneId)}\nrm -f ${quotedTmpFile}\n${command}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const sourceCommand = appleScriptString(`. ${quotedTmpFile}`);
    const script = `
tell application "System Events"
  tell process "Ghostty"
    set frontmost to true
    ${splitKeystroke}
    delay 0.4
    keystroke "${sourceCommand}"
    keystroke return
  end tell
end tell
`;

    await runFile("osascript", ["-e", script]);

    const focusedTty = await getFocusedGhosttyTty().catch(() => null);
    return {
      terminal: this.name,
      paneId,
      paneAliases: focusedTty ? [focusedTty] : [],
    };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
