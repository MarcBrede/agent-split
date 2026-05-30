import type { NormalizedEvent } from "../core/types.js";
import { readJsonl } from "../core/jsonl.js";

export async function readCodexRenderedEvents(path: string): Promise<string[]> {
  const records = await readJsonl(path);
  return records.flatMap(renderRecord).filter((event) => event.length > 0);
}

function renderRecord(record: unknown): string[] {
  if (!isObject(record) || record.type !== "response_item" || !isObject(record.payload)) {
    return [];
  }

  const event = normalizePayload(record.payload);
  if (!event) {
    return [];
  }

  switch (event.kind) {
    case "user":
      if (isNoisyUserText(event.text)) {
        return [];
      }
      return [`=== USER ===\n${event.text}`];
    case "assistant":
      return [`=== ASSISTANT ===\n${event.text}`];
    case "tool_call":
      return [`=== TOOL: ${event.name ?? "unknown"} ===\n${truncate(event.text)}`];
    case "tool_result":
      return [`=== TOOL RESULT ===\n${truncate(event.text)}`];
  }
}

function normalizePayload(payload: Record<string, unknown>): NormalizedEvent | null {
  if (payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "";
    const text = contentText(payload.content);
    if (!text) {
      return null;
    }
    if (role === "user") {
      return { kind: "user", text };
    }
    if (role === "assistant") {
      return { kind: "assistant", text };
    }
    return null;
  }

  if (payload.type === "function_call") {
    return {
      kind: "tool_call",
      name: typeof payload.name === "string" ? payload.name : "unknown",
      text: typeof payload.arguments === "string" ? payload.arguments : stringify(payload.arguments),
    };
  }

  if (payload.type === "function_call_output") {
    return {
      kind: "tool_result",
      text: typeof payload.output === "string" ? payload.output : stringify(payload.output),
    };
  }

  if (payload.type === "custom_tool_call") {
    return {
      kind: "tool_call",
      name: typeof payload.name === "string" ? payload.name : "custom",
      text: typeof payload.input === "string" ? payload.input : stringify(payload.input),
    };
  }

  if (payload.type === "custom_tool_call_output") {
    return {
      kind: "tool_result",
      text: typeof payload.output === "string" ? payload.output : stringify(payload.output),
    };
  }

  return null;
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
    if (
      (part.type === "input_text" ||
        part.type === "output_text" ||
        part.type === "text") &&
      typeof part.text === "string"
    ) {
      return part.text;
    }
    if (part.type === "input_image") {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
