// Parent process for test/process-utils.test.ts: spawns a child that prints its
// own pid, then mimics kiro-cli by exiting when stdin closes. With --ignore-eof
// it keeps running and swallows SIGTERM like a wedged engine.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(
  new URL('./process-tree-child.mjs', import.meta.url),
);
spawn(process.execPath, [childPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (process.argv.includes('--ignore-eof')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
