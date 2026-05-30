#!/usr/bin/env node
import { getAgentAdapter, getAgentAdapters } from "../agents/index.js";
import {
  configPath,
  normalizeMergeMode,
  normalizeOrientation,
  normalizeTintAmount,
  parseTerminalColor,
  readConfig,
  type MergeMode,
  type SisterConfig,
  type SplitOrientation,
} from "../core/config.js";
import { readForkMeta, readForkMetaForPane, writeForkMeta } from "../core/forkMeta.js";
import { formatMergePrompt } from "../core/mergePrompt.js";
import type { AgentAdapter, AgentName, LaunchSiblingOptions, SessionRef, TerminalContext, TerminalName } from "../core/types.js";
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
  const config = await readConfig();
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
  const mode = readMergeMode(args) ?? config.merge.mode;
  if (mode === "stdout") {
    process.stdout.write(`${output}\n`);
    return;
  }

  if (mode === "insert-parent" || mode === "submit-parent") {
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
    await terminalAdapter.insertText(meta.parentPaneId, output, { submit: mode === "submit-parent" });
    const verb = mode === "submit-parent" ? "Submitted" : "Inserted";
    console.log(`${verb} sister-session delta into parent ${meta.terminal} pane ${meta.parentPaneId}.`);
    return;
  }

  await copyToClipboard(output);
  console.log("Copied sister-session delta to clipboard.");
}

async function status(args: string[]): Promise<void> {
  const agentName = readOption(args, "--agent") ?? "auto";
  const terminal = await resolveTerminal(args);

  const { agent, session } = await resolveAgentSession(agentName, terminal);

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
  const config = await readConfig();
  const terminal = await resolveTerminal(args);

  const { agent, session } = await resolveAgentSession(agentName, terminal);

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
  const child = await terminalAdapter.launchSibling(terminal, command, readLaunchOptions(args, config, terminal.terminal));
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

async function resolveAgentSession(
  agentName: string,
  terminal: TerminalContext,
): Promise<{ agent: AgentAdapter; session: SessionRef }> {
  if (agentName !== "auto") {
    const agent = getAgentAdapter(agentName as AgentName);
    const session = await agent.detectCurrentSession(terminal);
    if (!session) {
      throw new Error(`Could not resolve current ${agent.name} session for ${terminal.terminal} pane ${terminal.paneId}.`);
    }
    return { agent, session };
  }

  const matches: Array<{ agent: AgentAdapter; session: SessionRef }> = [];
  for (const agent of getAgentAdapters()) {
    const session = await agent.detectCurrentSession(terminal);
    if (session) {
      matches.push({ agent, session });
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous active agent for ${terminal.terminal} pane ${terminal.paneId}: ${matches.map((match) => match.agent.name).join(", ")}. Pass --agent.`);
  }

  throw new Error(`Could not resolve current agent session for ${terminal.terminal} pane ${terminal.paneId}. Pass --agent codex or --agent claude.`);
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}.`);
  }
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readMergeMode(args: string[]): MergeMode | undefined {
  const modes: MergeMode[] = [];
  if (hasFlag(args, "--clipboard")) {
    modes.push("clipboard");
  }
  if (hasFlag(args, "--stdout")) {
    modes.push("stdout");
  }
  if (hasFlag(args, "--insert-parent")) {
    modes.push("insert-parent");
  }
  if (hasFlag(args, "--submit-parent")) {
    modes.push("submit-parent");
  }

  const mergeMode = readOption(args, "--merge-mode");
  if (mergeMode !== undefined) {
    modes.push(normalizeMergeMode(mergeMode, "--merge-mode"));
  }

  const distinctModes = new Set(modes);
  if (distinctModes.size > 1) {
    throw new Error("Pass only one merge output mode.");
  }

  return modes[0];
}

function readLaunchOptions(args: string[], config: SisterConfig, terminal: TerminalName): LaunchSiblingOptions {
  const options: LaunchSiblingOptions = {
    orientation: readOrientation(args) ?? config.fork.orientation,
  };

  const explicitVisuals = readVisualsEnabled(args);
  const hasVisualOverride = readOption(args, "--tint") !== undefined || readOption(args, "--tint-amount") !== undefined;
  const visualsEnabled = explicitVisuals ?? (hasVisualOverride ? true : config.visuals.enabled);
  if (visualsEnabled && terminal === "iterm") {
    options.tint = parseTerminalColor(readOption(args, "--tint") ?? config.visuals.iterm.childTint);
    options.tintAmount = readTintAmount(args) ?? config.visuals.iterm.tintAmount;
  }

  return options;
}

function readOrientation(args: string[]): SplitOrientation | undefined {
  const value = readOption(args, "--orientation");
  if (value === undefined) {
    return undefined;
  }
  return normalizeOrientation(value, "--orientation");
}

function readTintAmount(args: string[]): number | undefined {
  const value = readOption(args, "--tint-amount");
  if (value === undefined) {
    return undefined;
  }
  return normalizeTintAmount(Number(value), "--tint-amount");
}

function readVisualsEnabled(args: string[]): boolean | undefined {
  const enabled = hasFlag(args, "--visuals");
  const disabled = hasFlag(args, "--no-visuals");
  if (enabled && disabled) {
    throw new Error("Pass either --visuals or --no-visuals, not both.");
  }
  if (enabled) {
    return true;
  }
  if (disabled) {
    return false;
  }
  return undefined;
}

function printHelp(): void {
  console.log(`sister

Usage:
  sister status [--agent codex|claude]
  sister fork [--agent codex|claude] [--orientation horizontal|vertical] [--visuals|--no-visuals] [--tint #RRGGBB] [--tint-amount 0-1] [--focused]
  sister fork --print [--agent codex|claude]
  sister merge [--clipboard|--stdout|--insert-parent|--submit-parent] [--merge-mode mode] [--meta path] [--focused]

Commands:
  status   Print detected terminal and current agent session.
  fork     Start a sibling pane for the current or focused session.
  merge    Copy, print, or insert the current sibling session delta.

Config:
  ${configPath()}
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
