import { runFileWithInput } from "./shell.js";

export async function copyToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await runFileWithInput("pbcopy", [], text);
    return;
  }

  throw new Error("Clipboard copy is only implemented on macOS for now. Use --stdout.");
}
