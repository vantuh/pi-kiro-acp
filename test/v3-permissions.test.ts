// Test: the Kiro V3 permission gate — only a one-shot run of a pi_host tool is
// ever allowed, and v2 keeps its old answer. Driven by a fake ACP session: no
// kiro-cli is spawned.
// Run: npm test -- test/v3-permissions.test.ts

// Persisted sessions must never land in the developer's data dir.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'kiro-acp-data-'));

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { AcpSession } from '../src/session.ts';
import type { ForwardedToolCatalog } from '../src/tool-catalog.ts';
import { assert, fakeSession, parseLines } from './support.ts';

/** A catalog forwarding one tool, `slow`, under its kiro name. */
const catalogProvider = (): ForwardedToolCatalog => ({
  tools: [
    {
      piName: 'slow',
      kiroName: 'slow',
      description: 'slow tool',
      parameters: {},
    },
  ],
  piNameByKiroName: new Map([['slow', 'slow']]),
  fingerprint: 'v3-permissions-test',
  diagnostics: [],
});

/** V3 answers a permission request with `{optionId, name, kind}` options. */
function permissionRequest(
  session: AcpSession,
  written: string[],
  toolCall: Record<string, unknown>,
  options: Array<{ optionId?: string; id?: string; kind?: string }>,
): any {
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: { sessionId: 'acp-1', toolCall, options },
    }),
  );
  const reply = parseLines([...written]).at(-1);
  assert(reply?.id === 99, 'the permission request is answered');
  return reply.result;
}

const V3_OPTIONS = [
  { optionId: 'allow_always', kind: 'allow_always' },
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'reject_once', kind: 'reject_once' },
];

function v3Session(): { session: AcpSession; written: string[] } {
  const fake = fakeSession({ started: true, acpSessionId: 'acp-1' });
  fake.session.engine = 'v3';
  fake.session.catalogProvider = catalogProvider;
  return fake;
}

test('v3 allows only a once-off pi_host tool run', () => {
  const { session, written } = v3Session();

  const byIdentity = permissionRequest(
    session,
    written,
    {
      _meta: {
        kiro: {
          mcpTool: { identity: { serverName: 'pi_host', toolName: 'slow' } },
        },
      },
    },
    V3_OPTIONS,
  );
  assert(
    byIdentity?.outcome?.optionId === 'allow_once',
    `a pi_host tool (mcpTool identity) is allowed once (got ${JSON.stringify(byIdentity)})`,
  );

  const byTitle = permissionRequest(
    session,
    written,
    { title: '@pi_host/slow' },
    V3_OPTIONS,
  );
  assert(
    byTitle?.outcome?.optionId === 'allow_once',
    'a pi_host tool (title) is allowed once',
  );

  // V3 identifies a call by title/identity, so a name that is in the catalog
  // must still name pi_host as its server.
  const foreignServer = permissionRequest(
    session,
    written,
    { title: '@evil/slow' },
    V3_OPTIONS,
  );
  assert(
    foreignServer?.outcome?.optionId === 'reject_once',
    `a catalogue tool name under another server is rejected (got ${JSON.stringify(foreignServer)})`,
  );

  const notForwarded = permissionRequest(
    session,
    written,
    { title: '@pi_host/nope' },
    V3_OPTIONS,
  );
  assert(
    notForwarded?.outcome?.optionId === 'reject_once',
    'a pi_host tool the catalog does not forward is rejected',
  );

  const builtin = permissionRequest(
    session,
    written,
    { title: 'read' },
    V3_OPTIONS,
  );
  assert(
    builtin?.outcome?.optionId === 'reject_once',
    'a Kiro builtin is rejected even though allow_once is offered',
  );

  const standing = permissionRequest(
    session,
    written,
    { title: '@pi_host/slow' },
    [{ optionId: 'allow_always', kind: 'allow_always' }],
  );
  assert(
    JSON.stringify(standing) ===
      JSON.stringify({ outcome: { outcome: 'cancelled' } }),
    'a standing allow is never granted: the request is cancelled instead',
  );
});

test('v2 permission answers are unchanged', () => {
  const { session, written } = fakeSession({
    started: true,
    acpSessionId: 'acp-1',
  });
  session.catalogProvider = catalogProvider;
  // v2 options carry `id`, not `optionId`, and v2 kept preferring allow_always.
  const result = permissionRequest(
    session,
    written,
    { _meta: { kiro: { mcpServerName: 'pi_host', toolName: 'bash' } } },
    [{ id: 'reject_once' }, { id: 'allow_always' }],
  );
  assert(
    result?.outcome?.optionId === 'allow_always',
    'v2 still picks allow_always for a pi_host tool',
  );
});
