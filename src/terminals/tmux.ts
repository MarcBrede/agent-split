import { runFile } from "../platform/shell.js";
import type { LaunchResult, LaunchSiblingOptions, TerminalAdapter, TerminalContext } from "../core/types.js";

export class TmuxAdapter implements TerminalAdapter {
  name = "tmux" as const;

  async launchSibling(
    parent: TerminalContext,
    command: string,
    options: LaunchSiblingOptions = {},
  ): Promise<LaunchResult> {
    const orientation = options.orientation ?? "horizontal";
    // -h = horizontal split (side by side), -v = vertical split (stacked)
    const splitFlag = orientation === "vertical" ? "-v" : "-h";

    // Split next to the parent pane, not whatever pane happens to be focused
    const targetArgs = parent.paneId ? ["-t", parent.paneId] : [];
    const paneId = await runFile("tmux", [
      "split-window", splitFlag, "-P", "-F", "#{pane_id}", "-d", ...targetArgs,
    ]).then((out) => out.trim());

    if (!paneId) {
      throw new Error("Failed to create tmux split pane.");
    }

    // Send the command to the new pane
    await runFile("tmux", ["send-keys", "-t", paneId, command, "Enter"]);

    return { terminal: this.name, paneId };
  }
}
