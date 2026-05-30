import type { NormalizedEvent } from "../core/types.js";
import { readJsonl } from "../core/jsonl.js";

export async function readClaudeRenderedEvents(path: string): Promise<string[]> {
  const records = await readJsonl(path);
  return records.flatMap(renderRecord).filter((event) => event.length > 0);
}

function renderRecord(record: unknown): string[] {
  if (!isObject(record) || record.isSidechain === true) {
    return [];
  }

  if (record.type !== "user" && record.type !== "assistant") {
    return [];
  }

  if (!isObject(record.message)) {
    return [];
  }

  const role = typeof record.message.role === "string" ? record.message.role : "";
  if (role === "user") {
    return renderUserContent(record.message.content, record.toolUseResult).map(renderEvent);
  }
  if (role === "assistant") {
    return renderAssistantContent(record.message.content).map(renderEvent);
  }

  return [];
}

function renderUserContent(content: unknown, toolUseResult: unknown): NormalizedEvent[] {
  if (typeof content === "string") {
    return isNoisyUserText(content) ? [] : [{ kind: "user", text: content }];
  }

  if (!Array.isArray(content)) {
    const text = stringify(content);
    return text && !isNoisyUserText(text) ? [{ kind: "user", text }] : [];
  }

  const events: NormalizedEvent[] = [];
  const userText = content.map(userTextPart).filter(Boolean).join("\n");
  if (userText && !isNoisyUserText(userText)) {
    events.push({ kind: "user", text: userText });
  }

  for (const part of content) {
    if (!isObject(part) || part.type !== "tool_result") {
      continue;
    }

    const text = contentText(part.content) || stringify(toolUseResult);
    if (text) {
      events.push({ kind: "tool_result", text });
    }
  }

  return events;
}

function renderAssistantContent(content: unknown): NormalizedEvent[] {
  if (typeof content === "string") {
    return content ? [{ kind: "assistant", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    const text = stringify(content);
    return text ? [{ kind: "assistant", text }] : [];
  }

  const events: NormalizedEvent[] = [];
  const assistantText = content.map(assistantTextPart).filter(Boolean).join("\n");
  if (assistantText) {
    events.push({ kind: "assistant", text: assistantText });
  }

  for (const part of content) {
    if (!isObject(part) || part.type !== "tool_use") {
      continue;
    }

    events.push({
      kind: "tool_call",
      name: typeof part.name === "string" ? part.name : "unknown",
      text: stringify(part.input),
    });
  }

  return events;
}

function renderEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "user":
      return `=== USER ===\n${event.text}`;
    case "assistant":
      return `=== ASSISTANT ===\n${event.text}`;
    case "tool_call":
      return `=== TOOL: ${event.name ?? "unknown"} ===\n${truncate(event.text)}`;
    case "tool_result":
      return `=== TOOL RESULT ===\n${truncate(event.text)}`;
  }
}

function userTextPart(part: unknown): string {
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
}

function assistantTextPart(part: unknown): string {
  if (!isObject(part)) {
    return "";
  }

  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

  return "";
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
    if (part.type === "tool_reference" && typeof part.tool_name === "string") {
      return `[tool reference: ${part.tool_name}]`;
    }
    if (part.type === "image") {
      return "[image]";
    }
    return stringify(part);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
