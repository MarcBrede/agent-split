# sister

Sister lets you fork an active coding-agent session into a sibling session.
Use the sibling to continue another line of thought within the same scope while
the parent session keeps working on its current task. When the parent is ready,
merge the sibling back in so you can continue from one session with all relevant
context.

## macOS Setup

You will have to setup two shortcuts in macOS.

### Fork

1. Open the macOS Shortcuts app.
2. Create a new shortcut named `Fork`.
3. Add action: `Run Shell Script`.
4. Set `Shell` to `zsh` and `Input` to `None`.
5. Use this script:

   ```sh
   /opt/homebrew/bin/sister fork --focused
   ```

### Merge

1. Open the macOS Shortcuts app.
2. Create a new shortcut named `Merge`.
3. Add action: `Run Shell Script`.
4. Set `Shell` to `zsh` and `Input` to `None`.
5. Use this script:

   ```sh
   /opt/homebrew/bin/sister merge --focused --insert-parent
   ```
