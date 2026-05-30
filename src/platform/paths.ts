import os from "node:os";
import path from "node:path";

export function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? homePath(".codex");
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? homePath(".claude");
}

export function sisterHome(): string {
  return process.env.SISTER_HOME ?? homePath(".sister");
}
