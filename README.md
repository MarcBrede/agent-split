# agent-split

Agent Split helps you keep working while a coding agent is busy.

Agents like Claude and Codex can fork or resume sessions, but the workflow is
usually awkward when the current agent is already off doing work. You often end
up waiting for it to come back, even though there is another thread you could
explore in parallel if you had the current session context.

You can do this manually with commands like `codex fork --cd ... <session-id>`,
but that means opening another terminal, finding the right session id, copying
the working directory, and wiring everything up yourself. Agent Split automates
that flow: it detects the active session, opens a split pane, and starts a forked
agent session with the same context.

It also adds a merge flow that most agents do not provide. When the main session
finishes, and you have gathered useful context in the forked session, Agent Split
can compare the two transcripts, extract the delta from the fork, and insert that
context back into the parent session. You can then continue from the main session
with the additional work folded in.

https://github.com/user-attachments/assets/2da5b080-b0e7-4386-9f8b-ec7d8b189af1

## macOS Setup

Install Agent Split:

```sh
npm install -g agent-split
```

For this workflow, set up two macOS hotkey shortcuts that you can run
while focused in the agent session: one to start a fork and one to merge it back.

### Fork

1. Open the macOS Shortcuts app.
2. Create a new shortcut named `Fork`.
3. Add action: `Run Shell Script`.
4. Set `Shell` to `zsh` and `Input` to `None`.
5. Use this script:

   ```sh
   agent-split fork --focused
   ```

### Merge

1. Open the macOS Shortcuts app.
2. Create a new shortcut named `Merge`.
3. Add action: `Run Shell Script`.
4. Set `Shell` to `zsh` and `Input` to `None`.
5. Use this script:

   ```sh
   agent-split merge --focused --insert-parent
   ```
