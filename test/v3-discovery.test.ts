// Test: model discovery per engine — V3 reads the `model` config option from
// session/new and spawns the same flags as a session; v2 keeps
// `models.availableModels` and the bare `acp` invocation. Drives the fake
// `kiro-cli` on PATH; the real CLI is never started.
// Run: npm test -- test/v3-discovery.test.ts

import { test, vi } from 'vitest';

import { acpInvocations, assert, fakeKiroCli } from './support.ts';

test('v3 model discovery reads the model config option', async () => {
  const fake = fakeKiroCli();
  const savedEngine = process.env.PI_KIRO_ACP_AGENT_ENGINE;
  process.env.PI_KIRO_ACP_AGENT_ENGINE = 'v3';
  vi.resetModules();
  try {
    const { discoverKiroModels } = await import('../src/models/discovery.ts');
    const models = await discoverKiroModels(process.cwd());

    const acp = acpInvocations(fake.invocations());
    assert(
      acp.length === 1 &&
        acp[0].join(' ') === 'acp --agent-engine=v3 --auth-method=cli',
      `discovery spawns v3 like the session does (got "${acp[0]?.join(' ')}")`,
    );
    assert(
      models.map((model) => model.id).join(',') === 'auto,claude-sonnet-4.6',
      `model ids come from the model config option (got ${models.map((m) => m.id).join(',')})`,
    );
    assert(
      models.every((model) => model.name.endsWith('(Kiro)')),
      'discovered names keep the provider suffix',
    );
  } finally {
    if (savedEngine === undefined) delete process.env.PI_KIRO_ACP_AGENT_ENGINE;
    else process.env.PI_KIRO_ACP_AGENT_ENGINE = savedEngine;
    fake.restore();
  }
});

test('v2 model discovery still reads availableModels with no flags', async () => {
  const fake = fakeKiroCli();
  vi.resetModules();
  try {
    const { discoverKiroModels } = await import('../src/models/discovery.ts');
    const models = await discoverKiroModels(process.cwd());
    const acp = acpInvocations(fake.invocations());
    assert(
      acp.length === 1 && acp[0].join(' ') === 'acp',
      `v2 discovery keeps the bare acp invocation (got "${acp[0]?.join(' ')}")`,
    );
    assert(
      models.map((model) => model.id).join(',') === 'auto,claude-sonnet-4.6',
      `v2 ids still come from availableModels (got ${models.map((m) => m.id).join(',')})`,
    );
  } finally {
    fake.restore();
  }
});
