import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const LOG_FILE = join(tmpdir(), "kiro-acp-debug.log");

export function log(...args: any[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  appendFileSync(
    LOG_FILE,
    `[${ts}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}\n`,
  );
}
