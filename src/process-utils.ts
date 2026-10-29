import { execFileSync, type ChildProcess } from 'node:child_process';

const TERM_GRACE_MS = 1000;
const KILL_GRACE_MS = 1000;
const POLL_MS = 25;

/** Best-effort shutdown with bounded waits before SIGTERM/SIGKILL.
 * `knownDescendants` retains children reparented after the root exits. */
export async function terminateProcessTree(
  proc: ChildProcess,
  timeoutMs: number,
  knownDescendants?: number[],
): Promise<void> {
  const rootPid = proc.pid;
  // Snapshot before stdin.end(): children that outlive the root get reparented,
  // and pgrep -P <dead root> would no longer find them.
  const descendants = rootPid
    ? (knownDescendants ?? getDescendantPids(rootPid))
    : [];
  const owned = new Set<number>(rootPid ? [rootPid, ...descendants] : []);

  proc.stdin?.end();
  await waitForRootExit(proc, timeoutMs);

  // A dead root's pid may belong to someone else by now, and its reparented
  // children are only reachable through the snapshot kept above.
  if (rootExited(proc)) {
    if (rootPid) owned.delete(rootPid);
  } else if (rootPid) {
    // Children started between the snapshot and now are still ours to reap.
    for (const pid of getDescendantPids(rootPid)) owned.add(pid);
  }

  const signalOwned = (signal: NodeJS.Signals) => {
    for (const pid of [...owned].reverse()) {
      if (!isRunning(pid)) {
        owned.delete(pid);
        continue;
      }
      try {
        process.kill(pid, signal);
      } catch {}
    }
  };
  signalOwned('SIGTERM');
  await waitForTreeExit(owned, TERM_GRACE_MS);
  if (owned.size > 0) {
    signalOwned('SIGKILL');
    await waitForTreeExit(owned, KILL_GRACE_MS);
  }
}

function rootExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForRootExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (!proc.pid || rootExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      proc.removeListener('exit', done);
      resolve();
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(done, timeoutMs);
    proc.once('exit', done);
  });
}

// Reparented descendants no longer emit exit events through our ChildProcess.
async function waitForTreeExit(
  owned: Set<number>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pruneDead(owned) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// Retire dead pids before reuse; zombies cannot be killed and count as exited.
function pruneDead(owned: Set<number>): boolean {
  let alive = false;
  for (const pid of owned) {
    if (isRunning(pid)) alive = true;
    else owned.delete(pid);
  }
  return alive;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    // The pid existed a moment ago; a failed probe must not read as gone.
    return true;
  }
}

export function getDescendantPids(pid: number): number[] {
  const out: number[] = [];
  for (const child of getChildPids(pid)) {
    out.push(child, ...getDescendantPids(child));
  }
  return out;
}

function getChildPids(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
