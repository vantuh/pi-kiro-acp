// Test: the source-only provider subpath imports in plain Node, without a
// transform step hiding non-erasable TypeScript.
// Run: npm test -- test/node-import.test.ts

import { execFileSync } from 'node:child_process';

import { test } from 'vitest';

import { assert } from './support.ts';

test('the provider subpath imports in plain Node', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "Promise.all([import('@vantuh/pi-kiro-acp/provider'), import('@vantuh/pi-kiro-acp')]).then(([provider, root]) => console.log(typeof provider.createKiroAcpProvider, typeof root.default))",
    ],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert(
    output.trim() === 'function function',
    'plain Node imports the provider and root exports',
  );
});
