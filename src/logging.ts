import { appendFile, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKiroAcpConfig, resolveLoggerConfig } from './config.ts';

export const LOG_DIR = join(tmpdir(), 'kiro-acp-debug-logs');

/** One file per UTC day, matching the UTC time in each line. */
export function logFile(date = new Date()): string {
  return join(LOG_DIR, `${date.toISOString().slice(0, 10)}.log`);
}

const DEBUG = resolveLoggerConfig(loadKiroAcpConfig()).debug;

export function log(...args: any[]): void {
  if (!DEBUG) return;
  const now = new Date();
  const ts = now.toISOString().slice(11, 23);
  mkdirSync(LOG_DIR, { recursive: true });
  appendFile(
    logFile(now),
    `[${ts}] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`,
    () => {},
  );
}

/** Elapsed ms since `since` (Date.now()). */
export function msSince(since: number): number {
  return Date.now() - since;
}
