import { readJsonl } from "../core/jsonl.js";

interface PiEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: unknown;
  summary?: unknown;
  content?: unknown;
  display?: unknown;
  customType?: unknown;
}

export async function readPiRenderedEvents(path: string): Promise<string[]> {
  const records = await readJsonl(path);
  return activeBranch(records).flatMap(renderEntry).filter((event) => event.length > 0);
}

function activeBranch(records: unknown[]): PiEntry[] {
  const entries = records.filter(isEntry);
  const byId = new Map<string, PiEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.type !== "session") {
      byId.set(entry.id, entry);
    }
  }

  let leaf: PiEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry.id === "string" && entry.type !== "session") {
      leaf = entry;
      break;
    }
  }
  if (!leaf || typeof leaf.id !== "string") {
    return [];
  }

  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  let current: PiEntry | undefined = leaf;
  while (current && typeof current.id === "string" && !seen.has(current.id)) {
    seen.add(current.id);
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }

  return branch.reverse();
}

function renderEntry(entry: PiEntry): string[] {
  if (entry.type === "message") {
    return renderMessage(entry.message);
  }

  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return [`=== SUMMARY ===\n${entry.summary}`];
  }

  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return [`=== BRANCH SUMMARY ===\n${entry.summary}`];
  }

  if (entry.type === "custom_message" && entry.display !== false) {
    const label = typeof entry.customType === "string" ? entry.customType : "custom";
    const text = contentText(entry.content);
    return text ? [`=== CUSTOM: ${label} ===\n${text}`] : [];
  }

  return [];
}

function renderMessage(message: unknown): string[] {
  if (!isObject(message)) {
    return [];
  }

  switch (message.role) {
    case "user": {
      const text = contentText(message.content);
      return text && !isNoisyUserText(text) ? [`=== USER ===\n${text}`] : [];
    }
    case "assistant":
      return renderAssistantMessage(message);
    case "toolResult": {
      const name = typeof message.toolName === "string" ? `: ${message.toolName}` : "";
      const text = contentText(message.content);
      return text ? [`=== TOOL RESULT${name} ===\n${truncate(text)}`] : [];
    }
    case "bashExecution":
      return renderBashExecution(message);
    case "custom": {
      if (message.display === false) {
        return [];
      }
      const label = typeof message.customType === "string" ? message.customType : "custom";
      const text = contentText(message.content);
      return text ? [`=== CUSTOM: ${label} ===\n${text}`] : [];
    }
    case "branchSummary":
      return typeof message.summary === "string" ? [`=== BRANCH SUMMARY ===\n${message.summary}`] : [];
    case "compactionSummary":
      return typeof message.summary === "string" ? [`=== SUMMARY ===\n${message.summary}`] : [];
    default:
      return [];
  }
}

function renderAssistantMessage(message: Record<string, unknown>): string[] {
  const content = message.content;
  const events: string[] = [];

  const assistantText = assistantContentText(content);
  if (assistantText) {
    events.push(`=== ASSISTANT ===\n${assistantText}`);
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part) || part.type !== "toolCall") {
        continue;
      }

      const name = typeof part.name === "string" ? part.name : "unknown";
      const input = stringify(part.arguments);
      events.push(`=== TOOL: ${name} ===\n${truncate(input)}`);
    }
  }

  return events;
}

function renderBashExecution(message: Record<string, unknown>): string[] {
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  const exitCode = typeof message.exitCode === "number" ? `\nexitCode: ${message.exitCode}` : "";
  const text = [`$ ${command}`, output, exitCode].filter(Boolean).join("\n");
  return text ? [`=== TOOL: bash ===\n${truncate(text)}`] : [];
}

function assistantContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringify(content);
  }

  return content.map((part) => {
    if (!isObject(part)) {
      return "";
    }
    if (part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
    return "";
  }).filter(Boolean).join("\n");
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringify(content);
  }

  return content.map((part) => {
    if (!isObject(part)) {
      return "";
    }
    if (part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
    if (part.type === "image") {
      return "[image]";
    }
    return "";
  }).filter(Boolean).join("\n");
}

function isNoisyUserText(text: string): boolean {
  return [
    "<environment_context>",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<apps_instructions>",
    "<skills_instructions>",
    "<skill>",
    "<turn_aborted>",
  ].some((prefix) => text.startsWith(prefix));
}

function truncate(text: string): string {
  if (text.length <= 2_000) {
    return text;
  }
  return `${text.slice(0, 1_500)}\n...[truncated ${text.length - 2_000} chars]...\n${text.slice(-500)}`;
}

function stringify(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function isEntry(value: unknown): value is PiEntry {
  return isObject(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
