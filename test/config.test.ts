// Test: kiro-acp.json config resolvers (logger, usage footer, agent engine).
// Run: npm test -- test/config.test.ts

import { test } from 'vitest';

import {
  resolveAgentEngine,
  resolveLoggerConfig,
  resolveUsageFooterConfig,
} from '../src/config.ts';
import { assert, setEnv, withEnv } from './support.ts';

test('kiro-acp.json config resolvers', () => {
  // Env vars are ignored: logging is config-only.
  const restoreEnv = withEnv({
    PI_KIRO_ACP_DEBUG: '1',
    PI_KIRO_ACP_VERBOSE: '3',
  });
  let logger = resolveLoggerConfig({});
  assert(
    logger.debug === false && logger.verbose === 0,
    'defaults: debug off, verbose 0 (env ignored)',
  );

  // Config wins.
  logger = resolveLoggerConfig({ logger: { debug: true, verbose: 1 } });
  assert(
    logger.debug === true && logger.verbose === 1,
    'config values respected',
  );

  // verbose is clamped to 0..3 and explicit 0 is respected.
  logger = resolveLoggerConfig({ logger: { verbose: 9 } });
  assert(logger.verbose === 3, 'verbose clamped to 3');
  logger = resolveLoggerConfig({ logger: { debug: false, verbose: 0 } });
  assert(
    logger.debug === false && logger.verbose === 0,
    'explicit verbose 0 respected',
  );

  // --- resolveUsageFooterConfig ---

  assert(
    (() => {
      const c = resolveUsageFooterConfig({});
      return c.enabled === false && c.pollMinutes === 10;
    })(),
    'footer defaults: off, 10 minutes',
  );
  assert(
    (() => {
      const c = resolveUsageFooterConfig({
        usageFooter: { enabled: false, pollMinutes: 5 },
      });
      return c.enabled === false && c.pollMinutes === 5;
    })(),
    'footer config values respected',
  );
  assert(
    resolveUsageFooterConfig({ usageFooter: { pollMinutes: 0 } })
      .pollMinutes === 10,
    'invalid pollMinutes falls back to 10',
  );

  restoreEnv();
});

test('kiro-acp.json agent engine resolver', () => {
  const engineEnv = () => process.env.PI_KIRO_ACP_AGENT_ENGINE;
  const originalEngine = engineEnv();
  const restoreEnv = withEnv({ PI_KIRO_ACP_AGENT_ENGINE: undefined });
  try {
    assert(resolveAgentEngine({}) === 'v2', 'the engine defaults to v2');
    assert(
      resolveAgentEngine({ agentEngine: 'v2' }) === 'v2',
      'the engine can be pinned to v2',
    );
    assert(
      resolveAgentEngine({ agentEngine: 'v3' }) === 'v3',
      'v3 is opt-in through the config',
    );
    assert(
      resolveAgentEngine({ agentEngine: 'v9' as any }) === 'v2',
      'an unknown engine value falls back to v2',
    );

    // The env override lets a launcher switch engines without touching HOME.
    setEnv('PI_KIRO_ACP_AGENT_ENGINE', 'v3');
    assert(
      resolveAgentEngine({}) === 'v3' &&
        resolveAgentEngine({ agentEngine: 'v2' }) === 'v3',
      'the env override wins over the config file',
    );
    setEnv('PI_KIRO_ACP_AGENT_ENGINE', 'v2');
    assert(
      resolveAgentEngine({ agentEngine: 'v3' }) === 'v2',
      'the env override can pin v2 as well',
    );
    setEnv('PI_KIRO_ACP_AGENT_ENGINE', 'v4');
    assert(
      resolveAgentEngine({ agentEngine: 'v3' }) === 'v3',
      'an unrecognised env value is ignored',
    );
  } finally {
    restoreEnv();
    assert(
      engineEnv() === originalEngine,
      `the override is restored exactly — unset stays unset, not "undefined" (got ${engineEnv()})`,
    );
  }
});
