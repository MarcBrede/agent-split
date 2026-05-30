import type { AgentAdapter, AgentName } from "../core/types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { PiAdapter } from "./pi.js";

const adapters: AgentAdapter[] = [new CodexAdapter(), new ClaudeAdapter(), new PiAdapter()];

export function getAgentAdapters(): AgentAdapter[] {
  return adapters;
}

export function getAgentAdapter(name: AgentName | "auto"): AgentAdapter {
  if (name === "auto") {
    return adapters[0];
  }

  const adapter = adapters.find((candidate) => candidate.name === name);
  if (!adapter) {
    throw new Error(`Unsupported agent: ${name}`);
  }

  return adapter;
}
