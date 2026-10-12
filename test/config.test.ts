// Test: kiro-acp.json config resolvers (logger + usage footer).
// Run: npm test -- test/config.test.ts

import { test } from 'vitest';

import {
  resolveLoggerConfig,
  resolveUsageFooterConfig,
} from '../src/config.ts';
import { assert } from './support.ts';

test('kiro-acp.json config resolvers', () => {
  const savedEnv = { ...process.env };

  // --- resolveLoggerConfig ---

  // Env vars are ignored: logging is config-only.
  process.env.PI_KIRO_ACP_DEBUG = '1';
  process.env.PI_KIRO_ACP_VERBOSE = '3';
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

  process.env = savedEnv;
});
