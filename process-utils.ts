import { execFileSync, type ChildProcess } from "node:child_process";

/** Gracefully stop a spawned process tree: close stdin, wait for exit, SIGTERM
 * the root and every known descendant. Resolves either way.
 * `knownDescendants` lets callers that already walked the tree (for logging)
 * reuse that snapshot instead of re-running pgrep. */
export async function terminateProcessTree(
  proc: ChildProcess,
  timeoutMs: number,
  knownDescendants?: number[],
): Promise<void> {
  const rootPid = proc.pid;
  const descendants = rootPid
    ? knownDescendants ?? getDescendantPids(rootPid)
    : [];
  proc.stdin?.end();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killProcessTree(rootPid);
      resolve();
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  for (const pid of descendants) killProcessTree(pid);
}

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
