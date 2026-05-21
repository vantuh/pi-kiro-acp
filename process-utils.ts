import { execFileSync } from "node:child_process";

export function killProcessTree(pid?: number): void {
  if (!pid) return;
  const children = getChildPids(pid);
  for (const child of children) killProcessTree(child);
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

export function getDescendantPids(pid: number): number[] {
  const out: number[] = [];
  for (const child of getChildPids(pid)) {
    out.push(child, ...getDescendantPids(child));
  }
  return out;
}

function getChildPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
