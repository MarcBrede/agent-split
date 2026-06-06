import type { InsertTextOptions, LaunchResult, LaunchSiblingOptions, TerminalAdapter, TerminalContext } from "../core/types.js";
import { runFile } from "../platform/shell.js";

export async function detectFocusedItermContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TerminalContext | null> {
  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  if frontApp is not "iTerm2" then return ""
end tell
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
  set should_tint_child to false
  if item 2 of argv is "true" then
    set should_tint_child to true
  end if
  set tint_red to item 3 of argv as integer
  set tint_green to item 4 of argv as integer
  set tint_blue to item 5 of argv as integer
  set tint_amount to item 6 of argv as real
  tell application "iTerm2"
    set parent_session to current session of current window
    tell parent_session
      set new_session to (${splitCommand})
    end tell
    set child_pane_id to unique id of new_session
    if should_tint_child then
      set parent_bg to background color of parent_session
      set blended_red to ((item 1 of parent_bg) * (1 - tint_amount) + tint_red * tint_amount) as integer
      set blended_green to ((item 2 of parent_bg) * (1 - tint_amount) + tint_green * tint_amount) as integer
      set blended_blue to ((item 3 of parent_bg) * (1 - tint_amount) + tint_blue * tint_amount) as integer
      set blended_color to {blended_red, blended_green, blended_blue}
      if (count of parent_bg) is greater than 3 then
        set blended_color to {blended_red, blended_green, blended_blue, item 4 of parent_bg}
      end if
      set background color of new_session to blended_color
    end if
    tell new_session
      write text fork_command
      select
    end tell
    return child_pane_id
  end tell
end run
`;

    const shouldTint = options.tint !== undefined && options.tintAmount !== undefined && options.tintAmount > 0;
    const tint = options.tint ?? { red: 0, green: 0, blue: 0 };
    const tintAmount = options.tintAmount ?? 0;
    const paneId = await runFile("osascript", [
      "-e",
      script,
      command,
      String(shouldTint),
      String(tint.red),
      String(tint.green),
      String(tint.blue),
      String(tintAmount),
    ]);
    return {
      terminal: this.name,
      paneId,
    };
  }

  async insertText(paneId: string, text: string, options: InsertTextOptions = {}): Promise<void> {
    const script = `
on run argv
  set target_pane_id to item 1 of argv
  set insert_text to item 2 of argv
  set submit_text to false
  if item 3 of argv is "true" then
    set submit_text to true
  end if
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is target_pane_id then
            tell s
              write text insert_text newline submit_text
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

    await runFile("osascript", ["-e", script, paneId, text, String(options.submit ?? false)]);
  }
}
