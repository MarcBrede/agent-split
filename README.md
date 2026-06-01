# agent-split

Agent Split lets you fork an active coding-agent session into a split session.
Use the split session to continue another line of thought within the same scope while
the parent session keeps working on its current task. When the parent is ready,
merge the split session back in so you can continue from one session with all relevant
context.

## macOS Setup

Install Agent Split:

```sh
npm install -g agent-split
```

You will have to setup two shortcuts in macOS.

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
