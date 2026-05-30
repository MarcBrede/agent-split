import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ForkMeta } from "./types.js";
import { sisterHome } from "../platform/paths.js";

export async function writeForkMeta(meta: Omit<ForkMeta, "id" | "createdAt">): Promise<string> {
  const fullMeta: ForkMeta = {
    ...meta,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  const dir = path.join(sisterHome(), "forks");
  await fs.mkdir(dir, { recursive: true });

  const filename = [
    fullMeta.agent,
    fullMeta.terminal,
    fullMeta.childPaneId ? sanitizePathPart(fullMeta.childPaneId) : fullMeta.id,
  ].join("-");
  const filePath = path.join(dir, `${filename}.json`);

  await fs.writeFile(filePath, `${JSON.stringify(fullMeta, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readForkMetaForPane(paneId: string): Promise<ForkMeta | null> {
  const dir = path.join(sisterHome(), "forks");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const metas = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map(async (entry) => {
      const fullPath = path.join(dir, entry);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        return JSON.parse(content) as ForkMeta;
      } catch {
        return null;
      }
    }));

  const matches = metas
    .filter((meta): meta is ForkMeta => meta !== null)
    .filter((meta) => meta.childPaneId === paneId);

  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matches[0] ?? null;
}

export async function readForkMeta(pathOrPaneId: string): Promise<ForkMeta | null> {
  if (pathOrPaneId.endsWith(".json")) {
    const content = await fs.readFile(pathOrPaneId, "utf8");
    return JSON.parse(content) as ForkMeta;
  }

  return readForkMetaForPane(pathOrPaneId);
}

function sanitizePathPart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
