// Test: deny Kiro builtins, allow only pi_host / forwarded / pi_* tools.
// Run: npm test -- test/permissions.test.ts

import { test } from 'vitest';

import {
  isPiHostPermission,
  kiroToolIdentity,
  kiroToolNameFromPermissionParams,
  mcpServerFromPermissionParams,
  pickPermissionOptionId,
  pickV3PermissionOptionId,
} from '../src/permissions.ts';
import { assert } from './support.ts';

test('reads pi_host permission params', async () => {
  const params = {
    toolCall: {
      _meta: { kiro: { mcpServerName: 'pi_host', toolName: 'bash' } },
    },
  };
  assert(
    mcpServerFromPermissionParams(params) === 'pi_host',
    'reads mcpServer',
  );
  assert(kiroToolNameFromPermissionParams(params) === 'bash', 'reads toolName');
  assert(
    isPiHostPermission(params, []),
    'pi_host is allowed even with empty catalog',
  );
});

test('denies Kiro builtins but allows forwarded tools', async () => {
  assert(
    !isPiHostPermission({ toolCall: { toolName: 'subagent' } }, [
      'pi_subagent',
    ]),
    'native subagent is denied even if pi_subagent is forwarded',
  );
  assert(
    isPiHostPermission({ toolCall: { toolName: 'pi_subagent' } }, [
      'pi_subagent',
    ]),
    'aliased pi_subagent is allowed when the catalog lists it',
  );
  assert(
    !isPiHostPermission({ toolCall: { toolName: 'pi_subagent' } }, []),
    'pi_* names unknown to the catalog are denied (fail-safe, no blanket prefix allow)',
  );
  assert(
    isPiHostPermission({ toolCall: { toolName: 'bash' } }, ['bash']),
    'forwarded bash (not a Kiro builtin name) is allowed',
  );
  assert(
    !isPiHostPermission({ options: [{ id: 'allow_always' }] }, ['bash']),
    'unidentified permission is denied',
  );
});

test('reads the v3 tool identity shapes', async () => {
  const fromMcpTool = kiroToolIdentity({
    toolCall: {
      _meta: {
        kiro: {
          mcpTool: { identity: { serverName: 'pi_host', toolName: 'slow' } },
        },
      },
    },
  });
  assert(
    fromMcpTool.mcpServer === 'pi_host' && fromMcpTool.toolName === 'slow',
    'mcpTool.identity names the server and the tool',
  );

  const fromServerName = kiroToolIdentity({
    toolCall: { _meta: { kiro: { serverName: 'pi_host', toolName: 'slow' } } },
  });
  assert(
    fromServerName.mcpServer === 'pi_host' &&
      fromServerName.toolName === 'slow',
    'a plain serverName still identifies a pi_host call',
  );

  const fromTitle = kiroToolIdentity({ toolCall: { title: '@pi_host/slow' } });
  assert(
    fromTitle.mcpServer === 'pi_host' && fromTitle.toolName === 'slow',
    'the @server/tool title identifies a pi_host call',
  );
  assert(
    kiroToolIdentity({ title: '@pi_host/slow' }).mcpServer === 'pi_host',
    'the title is also read from the update itself',
  );

  const toolLoad = kiroToolIdentity({ toolCall: { title: 'Tool Load' } });
  assert(
    toolLoad.mcpServer === undefined && toolLoad.toolName === undefined,
    'a v3 meta tool (Tool Load) carries no identity and cannot pass as pi_host',
  );
  assert(
    kiroToolIdentity({
      toolCall: { toolName: 'tool_call', title: 'Use a tool' },
    }).mcpServer === undefined,
    'the tool_call meta tool is not mistaken for a pi_host call',
  );
  assert(
    !isPiHostPermission({ toolCall: { title: 'Tool Load' } }, ['slow']),
    'a meta tool is denied even when the catalog has other tools',
  );
});

test('picks a permission option id', async () => {
  const opts = [{ id: 'reject_once' }, { id: 'allow_always' }];
  assert(
    pickPermissionOptionId(opts, true) === 'allow_always',
    'allow prefers allow_always',
  );
  assert(
    pickPermissionOptionId(opts, false) === 'reject_once',
    'deny prefers reject_once when reject_always is missing',
  );
  assert(
    pickPermissionOptionId([{ id: 'allow_once' }], false) === null,
    'deny with no reject option returns null (caller cancels)',
  );
  assert(
    pickPermissionOptionId(
      [{ id: 'reject_once' }, { id: 'reject_always' }],
      true,
    ) === null,
    'allow with reject-only options never picks a reject (caller cancels)',
  );
});

test('picks a v3 permission option id', async () => {
  assert(
    pickV3PermissionOptionId(
      [
        { optionId: 'allow_always', kind: 'allow_always' },
        { optionId: 'allow_once', kind: 'allow_once' },
      ],
      true,
    ) === 'allow_once',
    'allow picks allow_once, never allow_always',
  );
  assert(
    pickV3PermissionOptionId(
      [
        { optionId: 'reject_always', kind: 'reject_always' },
        { optionId: 'reject_once', kind: 'reject_once' },
      ],
      false,
    ) === 'reject_once',
    'deny picks reject_once',
  );
  assert(
    pickV3PermissionOptionId(
      [{ optionId: 'allow_always', kind: 'allow_always' }],
      true,
    ) === null,
    'allow with only a standing option returns null (caller cancels)',
  );
  assert(
    pickV3PermissionOptionId([], false) === null,
    'no options at all returns null (caller cancels)',
  );
});
