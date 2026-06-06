export type AgentName = "codex" | "claude" | "pi" | "opencode";
export type TerminalName = "iterm" | "tmux" | "wezterm" | "kitty" | "ghostty" | "unknown";

export interface TerminalContext {
  terminal: TerminalName;
  paneId: string;
  env: NodeJS.ProcessEnv;
}

export interface SessionRef {
  agent: AgentName;
  id: string;
  cwd?: string;
  title?: string;
  transcriptPath?: string;
}

export interface AgentAdapter {
  name: AgentName;
  detectCurrentSession(ctx: TerminalContext, options?: AgentDetectionOptions): Promise<SessionRef | null>;
  buildForkCommand(parent: SessionRef, options?: AgentLaunchOptions): Promise<string>;
  captureForkSnapshot?(parent: SessionRef): Promise<Record<string, unknown>>;
  resolveForkChild?(meta: ForkMeta, ctx: TerminalContext): Promise<SessionRef | null>;
  renderDelta?(parent: SessionRef, child: SessionRef): Promise<string>;
}

export interface AgentDetectionOptions {
  strict?: boolean;
}

export interface AgentLaunchOptions {
  flags?: string[];
}

export interface LaunchSiblingOptions {
  orientation?: "horizontal" | "vertical";
  tint?: TerminalColor;
  tintAmount?: number;
}

export interface TerminalColor {
  red: number;
  green: number;
  blue: number;
}

export interface LaunchResult {
  terminal: TerminalName;
  paneId: string;
  paneAliases?: string[];
}

export interface TerminalAdapter {
  name: TerminalName;
  launchSibling(
    parent: TerminalContext,
    command: string,
    options?: LaunchSiblingOptions,
  ): Promise<LaunchResult>;
  insertText?(paneId: string, text: string, options?: InsertTextOptions): Promise<void>;
}

export interface InsertTextOptions {
  submit?: boolean;
}

export interface ForkMeta {
  id: string;
  createdAt: string;
  agent: AgentName;
  terminal: TerminalName;
  parentPaneId: string | null;
  childPaneId: string | null;
  childPaneAliases?: string[];
  parentSession: SessionRef;
  command: string;
  snapshot: Record<string, unknown>;
}

export interface NormalizedEvent {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  text: string;
  name?: string;
}
