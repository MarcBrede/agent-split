# sister

Fork coding-agent sessions into sister panes and merge useful context back.

This repo is intentionally split into two adapter layers:

- terminal adapters answer: where is the user currently running?
- agent adapters answer: which agent session is active there?

The core workflow should not depend on iTerm2, Codex, Claude, or any single
agent's private storage format.

Supported agent adapters:

- Codex
- Claude Code

## Development

```sh
npm install
npm run dev -- status
npm run dev -- fork --print
npm run dev -- status --agent claude
```

`sister fork` currently launches an iTerm2 split pane when iTerm is detected.
Use `--print` to inspect the generated agent command without launching a pane.

## Configuration

User settings live at:

```sh
~/.config/sister/config.json
```

If `XDG_CONFIG_HOME` is set, sister reads:

```sh
$XDG_CONFIG_HOME/sister/config.json
```

Example:

```json
{
  "fork": {
    "orientation": "horizontal"
  },
  "merge": {
    "mode": "clipboard"
  },
  "visuals": {
    "enabled": false,
    "iterm": {
      "childTint": "#4661ff",
      "tintAmount": 0.09
    }
  }
}
```

CLI flags override config values. Config values override built-in defaults.
`merge.mode` can be `clipboard`, `stdout`, `insert-parent`, or `submit-parent`.
Visual effects are off by default.

For a macOS hotkey or any process launched outside the agent pane, use focused
iTerm detection:

```sh
npm run dev -- fork --focused
```

This asks iTerm2 for the currently focused pane id, then tries each supported
agent adapter until one resolves the active session. Pass `--agent codex` or
`--agent claude` to force a specific adapter.

After doing work in the sister session, run merge from that sister pane:

```sh
npm run dev -- merge
npm run dev -- merge --stdout
npm run dev -- merge --insert-parent
npm run dev -- merge --submit-parent
```

`merge` finds the fork metadata for the current pane, resolves the child agent
session, renders parent and child transcripts into comparable text blocks, and
prints only the child-side delta after the shared prefix.

By default, `merge` uses `merge.mode` from the user config, which defaults to
`clipboard`. `--stdout` prints the delta instead. `--insert-parent` writes it
into the recorded parent iTerm2 pane without pressing Enter. `--submit-parent`
writes it into the parent pane and presses Enter.

## Claude Code

Claude Code support uses Claude's own session primitives and JSONL transcripts:

```sh
npm run dev -- fork --focused
npm run dev -- fork --agent claude
npm run dev -- fork --agent claude --focused
npm run dev -- fork --agent claude --print
```

The generated fork command is:

```sh
claude --resume <session-id> --fork-session
```

Merge works the same way as Codex: sister records fork metadata, resolves the
child Claude JSONL session, normalizes both transcripts, and returns only the
child-side delta after the shared prefix.
