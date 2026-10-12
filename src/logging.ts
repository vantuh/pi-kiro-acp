import { appendFile } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadKiroAcpConfig, resolveLoggerConfig } from "./config.ts";

export const LOG_FILE = join(tmpdir(), "kiro-acp-debug.log");

const DEBUG = resolveLoggerConfig(loadKiroAcpConfig()).debug;

export function log(...args: any[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().slice(11, 23);
  appendFile(
    LOG_FILE,
    `[${ts}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}\n`,
    () => {},
  );
}

/** Elapsed ms since `since` (Date.now()). */
export function msSince(since: number): number {
  return Date.now() - since;
}
