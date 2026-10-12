// Test: active extension-tool catalog filtering, aliases, and fingerprints.
// Run: npm test -- test/catalog.test.ts

import { createHash } from 'node:crypto';

import { test } from 'vitest';

import {
  buildForwardedToolCatalog,
  hostToolCatalog,
  isKiroToolName,
} from '../src/tool-catalog.ts';
import { assert } from './support.ts';

const schema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
};
const extension = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  parameters: schema,
  sourceInfo: { source: 'package' },
  ...extra,
});

test('active extension-tool catalog filtering', async () => {
  const catalog = buildForwardedToolCatalog(
    [
      extension('active_tool'),
      extension('inactive_tool'),
      extension('builtin_tool', { sourceInfo: { source: 'builtin' } }),
      extension('sdk_tool', { sourceInfo: { source: 'sdk' } }),
    ],
    ['active_tool', 'builtin_tool', 'sdk_tool'],
  );
  // Forwarded transport: builtin pi tools (read/bash/…) are forwarded too so
  // pi executes every call; only host-SDK customs stay out.
  const names = catalog.tools.map((tool) => tool.piName).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['active_tool', 'builtin_tool']),
    `active builtin and extension tools are exposed, sdk excluded (got ${names.join(', ')})`,
  );
  assert(
    catalog.tools[0]?.parameters === schema,
    'TypeBox/JSON schema is preserved',
  );
});

test('Kiro name aliases for clashing pi tools', async () => {
  const catalog = buildForwardedToolCatalog(
    [
      extension('subagent'),
      extension('read'),
      extension('bash'),
      extension('edit'),
      extension('todo_list'),
      extension('use_aws'),
      extension('code'),
    ],
    ['subagent', 'read', 'bash', 'edit', 'todo_list', 'use_aws', 'code'],
  );
  const byPi = Object.fromEntries(
    catalog.tools.map((tool) => [tool.piName, tool.kiroName]),
  );
  assert(byPi.subagent === 'pi_subagent', 'subagent aliases around AgentCrew');
  assert(byPi.read === 'pi_read', 'read aliases around FsRead');
  assert(
    byPi.bash === 'bash',
    'bash keeps its Pi name (no Kiro builtin clash)',
  );
  assert(byPi.edit === 'edit', 'edit keeps its Pi name');
  assert(
    byPi.todo_list === 'pi_todo_list' &&
      byPi.use_aws === 'pi_use_aws' &&
      byPi.code === 'pi_code',
    'v2-name builtins (todo_list/use_aws/code) alias too',
  );
  assert(
    catalog.piNameByKiroName.get('pi_subagent') === 'subagent',
    'pi_subagent maps back to Pi subagent',
  );
  assert(
    catalog.diagnostics.some((line) =>
      line.includes('Aliasing subagent → pi_subagent'),
    ),
    'builtin alias is recorded in diagnostics',
  );
});

test('an empty active set is an empty catalog', async () => {
  const catalog = buildForwardedToolCatalog([], []);
  assert(
    catalog.tools.length === 0,
    'empty active set produces an empty catalog',
  );
  assert(
    catalog.fingerprint.length === 64,
    'empty catalog has a SHA-256 fingerprint',
  );
});

test('missing description and schema fall back safely', async () => {
  const catalog = buildForwardedToolCatalog(
    [
      {
        name: 'missing_description',
        parameters: undefined,
        sourceInfo: { source: 'package' },
      },
    ],
    ['missing_description'],
  );
  assert(
    catalog.tools[0]?.description.includes('Host Pi extension tool'),
    'missing description gets a safe fallback',
  );
  assert(
    catalog.tools[0]?.parameters.type === 'object',
    'missing schema gets an empty object schema',
  );
  assert(
    catalog.diagnostics.length === 2,
    'fallbacks emit concise diagnostics',
  );

  const paddedDescription = '  preserve this spacing  ';
  const padded = buildForwardedToolCatalog(
    [extension('padded_description', { description: paddedDescription })],
    ['padded_description'],
  );
  assert(
    padded.tools[0]?.description === paddedDescription,
    'non-empty descriptions are preserved verbatim',
  );
});

test('incompatible tool names get order-independent aliases', async () => {
  const invalidName = 'tool.with.dot';
  const first = buildForwardedToolCatalog(
    [extension(invalidName), extension('valid_tool')],
    [invalidName, 'valid_tool'],
  );
  const reordered = buildForwardedToolCatalog(
    [extension('valid_tool'), extension(invalidName)],
    ['valid_tool', invalidName],
  );
  const aliased = first.tools.find((tool) => tool.piName === invalidName);
  assert(
    aliased && aliased.kiroName !== invalidName,
    'incompatible name receives an alias',
  );
  assert(
    isKiroToolName(aliased!.kiroName),
    'generated alias satisfies Kiro name constraints',
  );
  assert(
    aliased!.kiroName ===
      reordered.tools.find((tool) => tool.piName === invalidName)?.kiroName,
    'aliases are input-order independent',
  );
  assert(
    first.fingerprint === reordered.fingerprint,
    'fingerprint is input-order independent',
  );
});

test('alias collisions stay resolvable', async () => {
  const invalidName = 'collision.name';
  const hash = createHash('sha256').update(invalidName).digest('hex');
  const validCollision = `pi_${hash.slice(0, 16)}`;
  const catalog = buildForwardedToolCatalog(
    [extension(invalidName), extension(validCollision)],
    [invalidName, validCollision],
  );
  const invalid = catalog.tools.find((tool) => tool.piName === invalidName);
  assert(
    catalog.tools.length === 2,
    'alias collision does not drop either resolvable tool',
  );
  assert(
    catalog.tools.find((tool) => tool.piName === validCollision)?.kiroName ===
      validCollision,
    'valid name wins alias collision',
  );
  assert(
    invalid?.kiroName !== validCollision && invalid?.kiroName.length === 23,
    'collision gets a deterministic extended alias',
  );
  assert(
    catalog.piNameByKiroName.get(invalid!.kiroName) === invalidName,
    'alias maps unambiguously to the Pi name',
  );
});

test('peer_send union schema survives unchanged', async () => {
  const peerSendSchema = {
    anyOf: [
      {
        type: 'object',
        properties: { role: { type: 'string' }, content: { type: 'string' } },
        required: ['role', 'content'],
      },
      {
        type: 'object',
        properties: { agent: { type: 'string' }, message: { type: 'string' } },
        required: ['agent', 'message'],
      },
    ],
  };
  const catalog = buildForwardedToolCatalog(
    [extension('peer_send', { parameters: peerSendSchema })],
    ['peer_send'],
  );
  assert(
    JSON.stringify(catalog.tools[0]?.parameters) ===
      JSON.stringify(peerSendSchema),
    'peer_send union schema survives unchanged',
  );
});

test('the fingerprint tracks description, schema and name', async () => {
  const base = buildForwardedToolCatalog(
    [extension('fingerprint_tool')],
    ['fingerprint_tool'],
  );
  const changedDescription = buildForwardedToolCatalog(
    [extension('fingerprint_tool', { description: 'changed' })],
    ['fingerprint_tool'],
  );
  const changedSchema = buildForwardedToolCatalog(
    [
      extension('fingerprint_tool', {
        parameters: { type: 'object', properties: {} },
      }),
    ],
    ['fingerprint_tool'],
  );
  const changedName = buildForwardedToolCatalog(
    [extension('other_tool')],
    ['other_tool'],
  );
  assert(
    base.fingerprint !== changedDescription.fingerprint,
    'description changes fingerprint',
  );
  assert(
    base.fingerprint !== changedSchema.fingerprint,
    'schema changes fingerprint',
  );
  assert(
    base.fingerprint !== changedName.fingerprint,
    'name changes fingerprint',
  );
});

test('request tools win over a throwing session catalog', async () => {
  const request = [
    {
      name: 'propose_commit',
      description: 'Propose a conventional commit',
      parameters: schema,
    },
  ];
  const catalog = hostToolCatalog({
    requestTools: request,
    sessionTools: () => {
      throw new Error(
        'Extension runtime not initialized. Action methods cannot be called during extension loading.',
      );
    },
  });
  assert(
    catalog.tools.map((tool) => tool.piName).join() === 'propose_commit',
    'request tools win over a throwing session catalog (omp commit CLI load)',
  );
});

test('a throwing session catalog records a diagnostic', async () => {
  const catalog = hostToolCatalog({
    sessionTools: () => {
      throw new Error(
        'Extension runtime not initialized. Action methods cannot be called during extension loading.',
      );
    },
  });
  assert(
    catalog.tools.length === 0,
    'throwing session catalog yields no tools',
  );
  assert(
    catalog.diagnostics.some((line) =>
      line.includes('session tool catalog unavailable'),
    ),
    'throwing session catalog records a diagnostic instead of rejecting',
  );
});

test('an explicit empty request catalog is empty', async () => {
  const catalog = hostToolCatalog({ requestTools: [] });
  assert(
    catalog.tools.length === 0,
    'an explicit empty request catalog is empty, not a session fallback',
  );
});
