import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KiroAcpConfig {
  logger?: {
    /** Write $TMPDIR/kiro-acp-debug.log. Default: off. */
    debug?: boolean;
    /** kiro-cli `-v` repeat count, 0 = off, max 3. Default: 0. */
    verbose?: number;
  };
  usageFooter?: {
    /** Show Kiro usage in the footer. Default: false (off). */
    enabled?: boolean;
    /** Poll interval in minutes. Default: 10. */
    pollMinutes?: number;
  };
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "kiro-acp.json");

/** Reads ~/.pi/agent/kiro-acp.json; empty object when missing/invalid. */
export function loadKiroAcpConfig(): KiroAcpConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as KiroAcpConfig;
  } catch {
    return {};
  }
}

export interface LoggerConfig {
  debug: boolean;
  verbose: number;
}

/** Logger settings: config only, off when unset. */
export function resolveLoggerConfig(config: KiroAcpConfig): LoggerConfig {
  return {
    debug: config.logger?.debug ?? false,
    verbose: Math.min(3, Math.max(0, config.logger?.verbose ?? 0)),
  };
}

export interface UsageFooterConfig {
  enabled: boolean;
  pollMinutes: number;
}

/** Footer settings: config with defaults (off, poll every 10 minutes). */
export function resolveUsageFooterConfig(
  config: KiroAcpConfig,
): UsageFooterConfig {
  const enabled = config.usageFooter?.enabled;
  const pollMinutes = Number(config.usageFooter?.pollMinutes);
  return {
    enabled: typeof enabled === "boolean" ? enabled : false,
    pollMinutes:
      Number.isFinite(pollMinutes) && pollMinutes > 0 ? pollMinutes : 10,
  };
}
