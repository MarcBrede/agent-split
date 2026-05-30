#!/usr/bin/env node
import { getAgentAdapter } from "../agents/index.js";
import { readForkMeta, readForkMetaForPane, writeForkMeta } from "../core/forkMeta.js";
import { formatMergePrompt } from "../core/mergePrompt.js";
import type { TerminalContext } from "../core/types.js";
import { copyToClipboard } from "../platform/clipboard.js";
import { detectTerminalContext } from "../terminals/auto.js";
import { getTerminalAdapter } from "../terminals/index.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    await status(args);
    return;
  }

  if (command === "fork") {
    await fork(args);
    return;
  }

  if (command === "merge") {
    await merge(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function merge(args: string[]): Promise<void> {
  const terminal = await resolveTerminal(args);
  const metaPath = readOption(args, "--meta");
  const meta = metaPath
    ? await readForkMeta(metaPath)
    : terminal.paneId
      ? await readForkMetaForPane(terminal.paneId)
      : null;

  if (!meta) {
    throw new Error("Could not find fork metadata for the current pane. Pass --meta <path> to merge a specific fork.");
  }

  const agent = getAgentAdapter(meta.agent);
  if (!agent.resolveForkChild || !agent.renderDelta) {
    throw new Error(`Merge is not implemented for agent: ${agent.name}`);
  }

  const child = await agent.resolveForkChild(meta, terminal);
  if (!child) {
    throw new Error(`Could not resolve child ${agent.name} session for fork ${meta.id}.`);
  }

  const delta = await agent.renderDelta(meta.parentSession, child);
  if (!delta.trim()) {
    throw new Error("No sister-session delta found.");
  }

  const output = formatMergeOutput(agent.name, delta);
  if (hasFlag(args, "--stdout")) {
    process.stdout.write(`${output}\n`);
    return;
  }

  if (hasFlag(args, "--insert-parent")) {
    const terminalAdapter = getTerminalAdapter({
      terminal: meta.terminal,
      paneId: meta.parentPaneId ?? "",
      env: process.env,
    });
    if (!terminalAdapter?.insertText) {
      throw new Error(`Inserting into the parent pane is not implemented for terminal: ${meta.terminal}`);
    }
    if (!meta.parentPaneId) {
      throw new Error("Fork metadata does not include a parent pane id.");
    }
    await terminalAdapter.insertText(meta.parentPaneId, output);
    console.log(`Inserted sister-session delta into parent ${meta.terminal} pane ${meta.parentPaneId}.`);
    return;
  }

  await copyToClipboard(output);
  console.log("Copied sister-session delta to clipboard.");
}

async function status(args: string[]): Promise<void> {
  const agentName = readOption(args, "--agent") ?? "auto";
  const terminal = await resolveTerminal(args);

  const agent = getAgentAdapter(agentName as "auto");
  const session = await agent.detectCurrentSession(terminal);
  if (!session) {
    throw new Error(`Could not resolve current ${agent.name} session for ${terminal.terminal} pane ${terminal.paneId}.`);
  }

  console.log(JSON.stringify({
    terminal: {
      name: terminal.terminal,
      paneId: terminal.paneId || null,
    },
    session,
  }, null, 2));
}

async function fork(args: string[]): Promise<void> {
  const agentName = readOption(args, "--agent") ?? "auto";
  const terminal = await resolveTerminal(args);

  const agent = getAgentAdapter(agentName as "auto");
  const session = await agent.detectCurrentSession(terminal);
  if (!session) {
    throw new Error(`Could not resolve current ${agent.name} session for ${terminal.terminal} pane ${terminal.paneId}.`);
  }

  const command = await agent.buildForkCommand(session);
  if (hasFlag(args, "--print")) {
    console.log(command);
    return;
  }

  const terminalAdapter = getTerminalAdapter(terminal);
  if (!terminalAdapter) {
    throw new Error(`Launching sibling panes is not implemented for terminal: ${terminal.terminal}. Use --print to print the fork command.`);
  }

  const snapshot = agent.captureForkSnapshot ? await agent.captureForkSnapshot(session) : {};
  const child = await terminalAdapter.launchSibling(terminal, command, {
    orientation: readOrientation(args),
    tint: { red: 18000, green: 25000, blue: 65535 },
    tintAmount: 0.09,
  });
  const metaPath = await writeForkMeta({
    agent: agent.name,
    terminal: terminal.terminal,
    parentPaneId: terminal.paneId || null,
    childPaneId: child.paneId || null,
    parentSession: session,
    command,
    snapshot,
  });

  console.log(`Started ${agent.name} fork in ${child.terminal} pane ${child.paneId}`);
  console.log(`Wrote fork metadata: ${metaPath}`);
}

async function resolveTerminal(args: string[]): Promise<TerminalContext> {
  return await detectTerminalContext({ focused: hasFlag(args, "--focused") })
    ?? { terminal: "unknown" as const, paneId: "", env: process.env };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readOrientation(args: string[]): "horizontal" | "vertical" | undefined {
  const value = readOption(args, "--orientation");
  if (value === undefined) {
    return undefined;
  }
  if (value === "horizontal" || value === "vertical") {
    return value;
  }
  throw new Error(`Invalid --orientation value: ${value}`);
}

function printHelp(): void {
  console.log(`sister

Usage:
  sister status [--agent codex]
  sister fork [--agent codex] [--orientation horizontal|vertical] [--focused]
  sister fork --print [--agent codex]
  sister merge [--stdout] [--insert-parent] [--meta path] [--focused]

Commands:
  status   Print detected terminal and current agent session.
  fork     Start a sibling pane for the current or focused session.
  merge    Copy, print, or insert the current sibling session delta.
`);
}

function formatMergeOutput(agentName: string, delta: string): string {
  return [
    formatMergePrompt(agentName),
    "",
    delta,
  ].join("\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sister: ${message}`);
  process.exitCode = 1;
});
