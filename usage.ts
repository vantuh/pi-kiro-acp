import { spawn } from "node:child_process";

import { log } from "./logging.ts";

export interface KiroUsage {
  plan: string;
  /** Raw reset date from kiro-cli, e.g. "2026-10-01". */
  resetDate: string;
  /** Percent of plan credits used (0-100). */
  percent: number;
  /** Raw credits line inside parentheses, e.g. "212.99 of 5000 covered in plan". */
  credits: string;
}

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const FETCH_TIMEOUT_MS = 45_000;

/** Parses the output of `kiro-cli chat --no-interactive /usage`. */
export function parseKiroUsage(raw: string): KiroUsage | null {
  const text = raw.replace(ANSI_RE, "");
  const header = text.match(/Estimated Usage \| resets on ([^|]+) \| (.+)/);
  if (!header) return null;
  const credits = text.match(/Credits \(([^)]+)\)/);
  const percent = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return {
    plan: header[2].trim(),
    resetDate: header[1].trim(),
    percent: percent ? Number(percent[1]) : 0,
    credits: credits ? credits[1].trim() : "",
  };
}

function runKiroCli(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ["chat", "--no-interactive", "/usage"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${bin} /usage timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // kiro-cli writes the /usage report to stderr when not attached to a TTY.
      const output = out + err;
      if (code === 0 && output.trim()) {
        resolve(output);
      } else {
        reject(
          new Error(
            `${bin} /usage exited with code ${code}${output ? `: ${output.trim().slice(0, 200)}` : ""}`,
          ),
        );
      }
    });
  });
}

export async function fetchKiroUsage(): Promise<KiroUsage> {
  let raw: string;
  try {
    raw = await runKiroCli("kiro-cli");
  } catch (error) {
    // Fall back to `kiro` only when kiro-cli is not installed (same policy as my-usage).
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    raw = await runKiroCli("kiro");
  }
  const usage = parseKiroUsage(raw);
  if (!usage) throw new Error("could not parse kiro /usage output");
  return usage;
}

let cache: { usage: KiroUsage; fetchedAt: number } | null = null;
let inflight: Promise<KiroUsage> | null = null;

/**
 * Returns cached usage when younger than maxAgeMs, otherwise fetches fresh
 * data. Concurrent callers share one in-flight fetch.
 */
export async function getKiroUsage(maxAgeMs: number): Promise<KiroUsage> {
  if (cache && Date.now() - cache.fetchedAt <= maxAgeMs) return cache.usage;
  if (!inflight) {
    inflight = fetchKiroUsage()
      .then((usage) => {
        cache = { usage, fetchedAt: Date.now() };
        log("usage fetched", { percent: usage.percent, plan: usage.plan });
        return usage;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
