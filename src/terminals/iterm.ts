import type { LaunchResult, LaunchSiblingOptions, TerminalAdapter, TerminalContext } from "../core/types.js";
import { runFile } from "../platform/shell.js";

export async function detectFocusedItermContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalContext | null> {
  const script = `
tell application "iTerm2"
  return unique id of current session of current window
end tell
`;

  try {
    const paneId = await runFile("osascript", ["-e", script]);
    if (!paneId) {
      return null;
    }
    return {
      terminal: "iterm",
      paneId,
      env,
    };
  } catch {
    return null;
  }
}

export class ItermAdapter implements TerminalAdapter {
  name = "iterm" as const;

  async launchSibling(
    _parent: TerminalContext,
    command: string,
    options: LaunchSiblingOptions = {},
  ): Promise<LaunchResult> {
    const orientation = options.orientation ?? "horizontal";
    const splitCommand = orientation === "vertical"
      ? "split vertically with default profile"
      : "split horizontally with default profile";

    const script = `
on run argv
  set fork_command to item 1 of argv
  tell application "iTerm2"
    set parent_session to current session of current window
    tell parent_session
      set new_session to (${splitCommand})
    end tell
    set child_pane_id to unique id of new_session
    tell new_session
      write text fork_command
      select
    end tell
    return child_pane_id
  end tell
end run
`;

    const paneId = await runFile("osascript", ["-e", script, command]);
    return {
      terminal: this.name,
      paneId,
    };
  }

  async insertText(paneId: string, text: string): Promise<void> {
    const script = `
on run argv
  set target_pane_id to item 1 of argv
  set insert_text to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is target_pane_id then
            tell s
              write text insert_text newline NO
              select
            end tell
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "No iTerm2 pane found with id " & target_pane_id
end run
`;

    await runFile("osascript", ["-e", script, paneId, text]);
  }
}
