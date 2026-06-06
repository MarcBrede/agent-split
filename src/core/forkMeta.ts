import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, ForkMeta, TerminalName } from "./types.js";
import { agentSplitHome } from "../platform/paths.js";

export interface ForkMetaRef {
  id: string;
  path: string;
}

export function createForkMetaRef(agent: AgentName, terminal: TerminalName): ForkMetaRef {
  const id = randomUUID();
  return {
    id,
    path: forkMetaPath(agent, terminal, id),
  };
}

export async function writeForkMeta(meta: Omit<ForkMeta, "id" | "createdAt">, ref?: ForkMetaRef): Promise<string> {
  const fullMeta: ForkMeta = {
    ...meta,
    id: ref?.id ?? randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const dir = path.join(agentSplitHome(), "forks");
  await fs.mkdir(dir, { recursive: true });

  const filePath = ref?.path ?? forkMetaPath(
    fullMeta.agent,
    fullMeta.terminal,
    fullMeta.childPaneId ? sanitizePathPart(fullMeta.childPaneId) : fullMeta.id,
  );

  await fs.writeFile(filePath, `${JSON.stringify(fullMeta, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readForkMetaForPane(paneId: string): Promise<ForkMeta | null> {
  const matches = await readForkMetasForPane(paneId);
  return matches[0] ?? null;
}

export async function readForkMetasForPane(paneId: string): Promise<ForkMeta[]> {
  if (!paneId) {
    return [];
  }

  return (await readForkMetas())
    .filter((meta) => meta.childPaneId === paneId || (meta.childPaneAliases ?? []).includes(paneId));
}

export async function readForkMeta(pathOrPaneId: string): Promise<ForkMeta | null> {
  if (pathOrPaneId.endsWith(".json")) {
    const content = await fs.readFile(pathOrPaneId, "utf8");
    return JSON.parse(content) as ForkMeta;
  }

  return readForkMetaForPane(pathOrPaneId);
}

export async function readLatestForkForTerminal(terminal: string, agent?: AgentName): Promise<ForkMeta | null> {
  return (await readForkMetas())
    .find((meta) => meta.terminal === terminal && (!agent || meta.agent === agent)) ?? null;
}

export async function readLatestFork(agent?: AgentName): Promise<ForkMeta | null> {
  return (await readForkMetas())
    .find((meta) => !agent || meta.agent === agent) ?? null;
}

async function readForkMetas(): Promise<ForkMeta[]> {
  const dir = path.join(agentSplitHome(), "forks");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const metas = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        try {
          const content = await fs.readFile(path.join(dir, entry), "utf8");
          return JSON.parse(content) as ForkMeta;
        } catch {
          return null;
        }
      }),
  );

  const valid = metas.filter((meta): meta is ForkMeta => meta !== null);
  valid.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return valid;
}

function sanitizePathPart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function forkMetaPath(agent: AgentName, terminal: TerminalName, id: string): string {
  return path.join(agentSplitHome(), "forks", `${agent}-${terminal}-${sanitizePathPart(id)}.json`);
}
