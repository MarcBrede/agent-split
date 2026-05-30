import type { AgentAdapter, AgentName } from "../core/types.js";
import { CodexAdapter } from "./codex.js";

const adapters: AgentAdapter[] = [new CodexAdapter()];

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
