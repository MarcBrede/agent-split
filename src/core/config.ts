import fs from "node:fs/promises";
import path from "node:path";
import { homePath } from "../platform/paths.js";
import type { TerminalColor } from "./types.js";

export type SplitOrientation = "horizontal" | "vertical";

export interface SisterConfig {
  fork: {
    orientation: SplitOrientation;
  };
  visuals: {
    enabled: boolean;
    iterm: {
      childTint: string;
      tintAmount: number;
    };
  };
}

export const DEFAULT_CONFIG: SisterConfig = {
  fork: {
    orientation: "horizontal",
  },
  visuals: {
    enabled: false,
    iterm: {
      childTint: "#4661ff",
      tintAmount: 0.09,
    },
  },
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || homePath(".config");
  return path.join(configHome, "sister", "config.json");
}

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<SisterConfig> {
  const filePath = configPath(env);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return DEFAULT_CONFIG;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse config at ${filePath}: ${message}`);
  }

  return normalizeConfig(parsed, filePath);
}

export function parseTerminalColor(value: string): TerminalColor {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid color value: ${value}. Expected #RRGGBB.`);
  }

  const hex = match[1];
  return {
    red: parseInt(hex.slice(0, 2), 16) * 257,
    green: parseInt(hex.slice(2, 4), 16) * 257,
    blue: parseInt(hex.slice(4, 6), 16) * 257,
  };
}

function normalizeConfig(value: unknown, filePath: string): SisterConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid config at ${filePath}: expected a JSON object.`);
  }

  const config = structuredClone(DEFAULT_CONFIG);
  const fork = optionalRecord(value.fork, "fork", filePath);
  const visuals = optionalRecord(value.visuals, "visuals", filePath);

  if (fork?.orientation !== undefined) {
    config.fork.orientation = normalizeOrientation(fork.orientation, "fork.orientation", filePath);
  }

  if (visuals?.enabled !== undefined) {
    if (typeof visuals.enabled !== "boolean") {
      throw new Error(`Invalid config at ${filePath}: visuals.enabled must be a boolean.`);
    }
    config.visuals.enabled = visuals.enabled;
  }

  const iterm = optionalRecord(visuals?.iterm, "visuals.iterm", filePath);
  if (iterm?.childTint !== undefined) {
    if (typeof iterm.childTint !== "string") {
      throw new Error(`Invalid config at ${filePath}: visuals.iterm.childTint must be a string.`);
    }
    parseTerminalColor(iterm.childTint);
    config.visuals.iterm.childTint = iterm.childTint;
  }

  if (iterm?.tintAmount !== undefined) {
    config.visuals.iterm.tintAmount = normalizeTintAmount(iterm.tintAmount, "visuals.iterm.tintAmount", filePath);
  }

  return config;
}

export function normalizeTintAmount(value: unknown, name: string, filePath = "CLI"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${name} in ${filePath}: expected a number from 0 to 1.`);
  }
  return value;
}

export function normalizeOrientation(value: unknown, name: string, filePath = "CLI"): SplitOrientation {
  if (value === "horizontal" || value === "vertical") {
    return value;
  }
  throw new Error(`Invalid ${name} in ${filePath}: expected horizontal or vertical.`);
}

function optionalRecord(value: unknown, name: string, filePath: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value)) {
    return value;
  }
  throw new Error(`Invalid config at ${filePath}: ${name} must be an object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
