// Test: terminateProcessTree leaves no live provider-owned process behind.
// Real OS processes only: test/fixtures/process-tree-parent.mjs spawns a child
// that ignores SIGTERM, so a leak shows up as a live pid after shutdown.
// Run: npm test -- test/process-utils.test.ts

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import {
  getDescendantPids,
  terminateProcessTree,
} from '../src/process-utils.ts';
import { assert } from './support.ts';

const parentPath = fileURLToPath(
  new URL('./fixtures/process-tree-parent.mjs', import.meta.url),
);

/** Budget the helper may spend beyond its graceful `timeoutMs`. */
const ESCALATION_BUDGET_MS = 2000;

// Liveness probes below shell out to ps; the helper's Windows fallback is
// covered by the source, not by these POSIX process fixtures.
const posix = process.platform !== 'win32';

function spawnTree(flag?: string): ChildProcess {
  const proc = spawn(process.execPath, [parentPath, ...(flag ? [flag] : [])], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  proc.stdout!.setEncoding('utf8');
  return proc;
}

/** Waits for the child's self-reported pid in the parent's stdout. */
async function waitForChildPid(proc: ChildProcess): Promise<number> {
  let output = '';
  proc.stdout!.on('data', (chunk: string) => {
    output += chunk;
  });
  for (let i = 0; i < 400; i++) {
    const match = output.match(/^child (\d+)$/m);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`child pid never reported: ${JSON.stringify(output)}`);
}

/** Running, not merely an unreaped zombie: a zombie could never be killed. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return true;
  }
}

/** Cleanup kills only pids this test spawned: the root while it is still alive
 * (plus whatever it spawned), and the child pids the test has learned. */
function killOwned(parent: ChildProcess, knownPids: number[]): void {
  const pids = [...knownPids];
  if (parent.pid && parent.exitCode === null && parent.signalCode === null) {
    pids.unshift(parent.pid, ...getDescendantPids(parent.pid));
  }
  for (const pid of pids) {
    if (!running(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

test.skipIf(!posix)(
  'waits for a reparented child that ignores SIGTERM',
  async () => {
    const parent = spawnTree();
    const knownPids: number[] = [];
    try {
      const childPid = await waitForChildPid(parent);
      knownPids.push(childPid);

      const startedAt = Date.now();
      await terminateProcessTree(parent, 300);
      const elapsed = Date.now() - startedAt;

      assert(parent.exitCode === 0, 'root exited on its own stdin close');
      assert(
        !running(childPid),
        'child ignoring SIGTERM is gone once terminateProcessTree resolves',
      );
      assert(
        elapsed < 300 + ESCALATION_BUDGET_MS + 500,
        `tree wait stays bounded (${elapsed}ms)`,
      );
    } finally {
      killOwned(parent, knownPids);
    }
  },
);

test.skipIf(!posix)(
  'escalates to SIGKILL when root and child ignore SIGTERM',
  async () => {
    const parent = spawnTree('--ignore-eof');
    const knownPids: number[] = [];
    try {
      const childPid = await waitForChildPid(parent);
      knownPids.push(childPid);
      assert(running(childPid), 'child is alive before shutdown');

      const startedAt = Date.now();
      await terminateProcessTree(parent, 300);
      const elapsed = Date.now() - startedAt;

      assert(!running(parent.pid!), 'root that ignored SIGTERM is gone');
      assert(!running(childPid), 'child that ignored SIGTERM is gone');
      assert(
        elapsed < 300 + ESCALATION_BUDGET_MS + 500,
        `escalation stays bounded (${elapsed}ms)`,
      );
    } finally {
      killOwned(parent, knownPids);
    }
  },
);

test.skipIf(!posix)(
  'cleans provided known descendants after the root exited',
  async () => {
    const parent = spawnTree();
    const knownPids: number[] = [];
    try {
      const childPid = await waitForChildPid(parent);
      knownPids.push(childPid);

      parent.stdin!.end();
      await once(parent, 'exit');
      assert(parent.exitCode === 0, 'root exited on its own stdin close');
      assert(running(childPid), 'reparented child is alive before shutdown');

      const startedAt = Date.now();
      await terminateProcessTree(parent, 5000, [childPid]);
      const elapsed = Date.now() - startedAt;

      assert(!running(childPid), 'known child is gone once the call resolves');
      assert(
        elapsed < 3000,
        `already-exited root skips the graceful wait (${elapsed}ms)`,
      );
    } finally {
      killOwned(parent, knownPids);
    }
  },
);
