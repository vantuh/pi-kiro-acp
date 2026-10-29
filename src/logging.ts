import { appendFile, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadKiroAcpConfig, resolveLoggerConfig } from './config.ts';

export const LOG_DIR = join(tmpdir(), 'kiro-acp-debug-logs');

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function logDir(date = new Date()): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return join(LOG_DIR, day);
}

/** One file per local day and session; lines without a session go to `_general`. */
export function logFile(session?: string, date = new Date()): string {
  const name = session ? session.replace(/[^\w.-]/g, '_') : '_general';
  return join(logDir(date), `${name}.log`);
}

function sessionOf(args: unknown[]): string | undefined {
  for (const a of args) {
    if (
      a &&
      typeof a === 'object' &&
      'session' in a &&
      typeof a.session === 'string'
    ) {
      return a.session;
    }
  }
  return undefined;
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const DEBUG = resolveLoggerConfig(loadKiroAcpConfig()).debug;

export function log(...args: any[]): void {
  if (!DEBUG) return;
  const now = new Date();
  const ts = localTime(now);
  mkdirSync(logDir(now), { recursive: true });
  appendFile(
    logFile(sessionOf(args), now),
    `[${ts}] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}\n`,
    () => {},
  );
}

/** Elapsed ms since `since` (Date.now()). */
export function msSince(since: number): number {
  return Date.now() - since;
}
