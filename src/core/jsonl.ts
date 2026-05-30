import fs from "node:fs";
import readline from "node:readline";

export async function readJsonl(path: string): Promise<unknown[]> {
  const stream = fs.createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  const records: unknown[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    records.push(JSON.parse(trimmed));
  }

  return records;
}
