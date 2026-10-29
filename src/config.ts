import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface KiroAcpConfig {
  logger?: {
    /** Write $TMPDIR/kiro-acp-debug-logs/YYYY-MM-DD/<session>.log. Default: off. */
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
  /** Kiro CLI engine to drive. Default: v2. */
  agentEngine?: 'v2' | 'v3';
}

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'kiro-acp.json');

/** Reads ~/.pi/agent/kiro-acp.json; empty object when missing/invalid. */
export function loadKiroAcpConfig(): KiroAcpConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as KiroAcpConfig;
  } catch {
    return {};
  }
}

interface LoggerConfig {
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

interface UsageFooterConfig {
  enabled: boolean;
  pollMinutes: number;
}

export type AgentEngine = 'v2' | 'v3';

/** `PI_KIRO_ACP_AGENT_ENGINE` overrides the config file so a launcher can pick
 * the engine without touching HOME (where the kiro-cli login lives). */
const AGENT_ENGINE_ENV = 'PI_KIRO_ACP_AGENT_ENGINE';

/** Engine setting: env, then the config file, then v2; anything unrecognised is
 * ignored rather than guessed. */
export function resolveAgentEngine(config: KiroAcpConfig): AgentEngine {
  const fromEnv = process.env[AGENT_ENGINE_ENV];
  if (fromEnv === 'v2' || fromEnv === 'v3') return fromEnv;
  return config.agentEngine === 'v3' ? 'v3' : 'v2';
}

/** Footer settings: config with defaults (off, poll every 10 minutes). */
export function resolveUsageFooterConfig(
  config: KiroAcpConfig,
): UsageFooterConfig {
  const enabled = config.usageFooter?.enabled;
  const pollMinutes = Number(config.usageFooter?.pollMinutes);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : false,
    pollMinutes:
      Number.isFinite(pollMinutes) && pollMinutes > 0 ? pollMinutes : 10,
  };
}
