# sister

Fork coding-agent sessions into sister panes and merge useful context back.

This repo is intentionally split into two adapter layers:

- terminal adapters answer: where is the user currently running?
- agent adapters answer: which agent session is active there?

The core workflow should not depend on iTerm2, Codex, Claude, or any single
agent's private storage format.

## Development

```sh
npm install
npm run dev -- status
npm run dev -- fork --print
```

`sister fork` currently launches an iTerm2 split pane when iTerm is detected.
Use `--print` to inspect the generated agent command without launching a pane.

For a macOS hotkey or any process launched outside the agent pane, use focused
iTerm detection:

```sh
npm run dev -- fork --focused
```

This asks iTerm2 for the currently focused pane id, then maps that pane back to
the active Codex session via `~/.codex/shell_snapshots` and
`~/.codex/state_5.sqlite`.

After doing work in the sister session, run merge from that sister pane:

```sh
npm run dev -- merge
npm run dev -- merge --stdout
npm run dev -- merge --insert-parent
```

`merge` finds the fork metadata for the current pane, resolves the child agent
session, renders parent and child transcripts into comparable text blocks, and
prints only the child-side delta after the shared prefix.

By default, `merge` copies the delta to the clipboard. `--stdout` prints it
instead. `--insert-parent` writes it into the recorded parent iTerm2 pane without
pressing Enter.
