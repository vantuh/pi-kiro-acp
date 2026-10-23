// Test: the Pocket adapter registers the native provider through Pocket's
// two public host members, and gives it back on disposal.
// Run: npm test -- test/pocket.test.ts

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { afterAll, test } from 'vitest';

import { KIRO_MODELS } from '../src/models/fallback.ts';
import { KIRO_ACP_PROVIDER } from '../src/overflow.ts';
import pocketAdapter from '../src/pocket.ts';
import { KIRO_ACP_API } from '../src/provider.ts';
import { assert } from './support.ts';

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A real Pi model runtime on an isolated auth/models folder. */
function newRuntime(): Promise<ModelRuntime> {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-pocket-'));
  dirs.push(dir);
  return ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(dir, 'models-store.json'),
    refreshOnCreate: false,
  });
}

/** The Pocket web boundary: one cleanup list, as Pocket keeps it. */
function pocketWeb() {
  const disposers: (() => unknown)[] = [];
  return {
    web: {
      onDispose(dispose: () => unknown) {
        disposers.push(dispose);
      },
    },
    disposers,
  };
}

/** The Pocket host and web boundary: two public members, nothing internal. */
function pocketHost(runtime: ModelRuntime) {
  const configs = new Map<string, ProviderConfig>();
  const { web, disposers } = pocketWeb();
  const host = {
    registerModelProvider(provider: string, config: ProviderConfig) {
      configs.set(provider, config);
      runtime.registerProvider(provider, config);
      return () => runtime.unregisterProvider(provider);
    },
  };
  return { host, web, configs, disposers };
}

/** A closed-mode event list for a stream, so no kiro-cli process starts. */
async function eventTypes(
  config: ProviderConfig,
  model: ReturnType<ModelRuntime['getModels']>[number],
) {
  const events: any[] = [];
  for await (const event of config.streamSimple!(model, {
    messages: [],
  } as any))
    events.push(event);
  return events;
}

test('the adapter registers the native provider with a visible catalog', async () => {
  const runtime = await newRuntime();
  const { host, web, configs, disposers } = pocketHost(runtime);

  await pocketAdapter(host, web);

  const provider = runtime.getProvider(KIRO_ACP_PROVIDER);
  assert(!!provider, 'Pocket resolves the registered provider');
  assert(
    provider!.getModels().length === KIRO_MODELS.length,
    'the fallback catalog is visible before any refresh',
  );

  const config = configs.get(KIRO_ACP_PROVIDER)!;
  assert(
    config.api === KIRO_ACP_API,
    'models dispatch through the native stream API',
  );
  assert(
    config.apiKey === 'kiro-cli-ambient',
    'the availability marker is not a user credential',
  );
  assert(config.authHeader === false, 'no Authorization header is added');

  const auth = await runtime.checkAuth(KIRO_ACP_PROVIDER);
  assert(
    auth?.type === 'api_key' && auth.source === 'configured API key',
    `availability is a configured key, not ambient auth (got ${auth?.source})`,
  );

  const local = await runtime.refresh({
    allowNetwork: false,
    providers: [KIRO_ACP_PROVIDER],
  });
  assert(!local.errors.has(KIRO_ACP_PROVIDER), 'a local refresh succeeds');
  assert(
    runtime.getModels(KIRO_ACP_PROVIDER).length === KIRO_MODELS.length,
    'a local refresh keeps the catalog instead of emptying it',
  );

  const refreshContext = {
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async () => true,
  };
  const fallback = await config.refreshModels!(refreshContext);
  assert(
    fallback.length === KIRO_MODELS.length,
    'the bridged refresh returns the native catalog',
  );
  fallback.length = 0;
  const again = await config.refreshModels!(refreshContext);
  assert(
    again.length === KIRO_MODELS.length,
    'mutating the copy leaves the native catalog intact',
  );
  assert(disposers.length === 1, 'one cleanup is registered');
  await disposers[0]();
});

test('disposal unregisters the provider, then closes the native one', async () => {
  const runtime = await newRuntime();
  const { host, web, configs, disposers } = pocketHost(runtime);

  await pocketAdapter(host, web);
  const config = configs.get(KIRO_ACP_PROVIDER)!;
  const model = runtime.getModels(KIRO_ACP_PROVIDER)[0];
  assert(!!model, 'the registered catalog has a model');

  await disposers[0]();

  assert(
    runtime.getProvider(KIRO_ACP_PROVIDER) === undefined,
    'disposal removes the provider from Pocket',
  );
  const events = await eventTypes(config, model);
  const error = events.at(-1);
  assert(
    error?.type === 'error' &&
      error.error?.errorMessage === 'Kiro ACP provider is closed',
    `the native provider is closed after disposal (got ${error?.error?.errorMessage})`,
  );
});

test('Pocket rollback closes the provider after a refused registration', async () => {
  const { web, disposers } = pocketWeb();
  let config: ProviderConfig | undefined;
  const host = {
    registerModelProvider(_provider: string, value: ProviderConfig) {
      config = value;
      throw new Error('refused');
    },
  };

  let failed: Error | undefined;
  try {
    pocketAdapter(host, web);
  } catch (error) {
    failed = error as Error;
  }

  assert(failed?.message === 'refused', 'the refusal reaches Pocket');
  assert(
    disposers.length === 1,
    'the cleanup is registered before the attempt',
  );

  // Pocket runs the module's cleanups when loading fails.
  await disposers[0]();
  const events = await eventTypes(config!, { id: 'auto' } as any);
  const error = events.at(-1);
  assert(
    error?.type === 'error' &&
      error.error?.errorMessage === 'Kiro ACP provider is closed',
    `a failed setup does not leave an open provider behind (got ${error?.error?.errorMessage})`,
  );
});

test('an older host is refused with a clear error', () => {
  let disposed = 0;
  let failed: Error | undefined;
  try {
    pocketAdapter({}, { onDispose: () => void (disposed += 1) });
  } catch (error) {
    failed = error as Error;
  }

  assert(
    failed?.message.includes('Pocket 0.20') === true,
    `the error names the needed Pocket version (got ${failed?.message})`,
  );
  assert(disposed === 0, 'no cleanup is registered without the API');
});
