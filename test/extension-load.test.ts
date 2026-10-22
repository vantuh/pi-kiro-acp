// Test: the extension loads and registers its provider (Risk 2 gate — a dangling
// import after cleanup would silently remove every kiro-acp model from pi).
// Run: npm test -- test/extension-load.test.ts

import { test } from 'vitest';

import { KIRO_ACP_PROVIDER } from '../src/overflow.ts';
import { assert } from './support.ts';

test('the extension loads and registers its provider', async () => {
  const events: string[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const providers: Array<{ id: string; config: any }> = [];
  const commands: string[] = [];

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      events.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, _options: unknown) {
      commands.push(name);
    },
    registerProvider(idOrProvider: any, config?: any) {
      providers.push({
        id: typeof idOrProvider === 'string' ? idOrProvider : idOrProvider.id,
        config: config ?? idOrProvider,
      });
    },
  } as any;

  const register = (await import('../src/index.ts')).default;
  assert(
    typeof register === 'function',
    'index.ts exports a default registration function',
  );

  register(pi);

  assert(
    providers.length === 1,
    'registration registers exactly one provider synchronously',
  );
  assert(providers[0].id === KIRO_ACP_PROVIDER, 'the provider id is kiro-acp');

  const provider = providers[0].config;
  assert(
    provider.id === KIRO_ACP_PROVIDER,
    'the registered object is a native provider',
  );
  assert(provider.getModels().length > 0, 'the provider ships fallback models');
  assert(
    provider.getModels().every((m: any) => typeof m.id === 'string' && m.id),
    'every model has an id',
  );
  assert(
    provider.getModels().every((m: any) => m.provider === KIRO_ACP_PROVIDER),
    'every model belongs to kiro-acp',
  );
  assert(
    typeof provider.streamSimple === 'function',
    'the provider exposes streamSimple',
  );
  assert(
    typeof provider.auth.apiKey?.resolve === 'function' &&
      provider.auth.apiKey.login === undefined,
    'the provider uses ambient kiro-cli auth without a login flow',
  );

  for (const event of [
    'session_start',
    'turn_start',
    'message_start',
    'context',
    'message_end',
    'session_shutdown',
  ]) {
    assert(events.includes(event), `the extension subscribes to ${event}`);
  }

  assert(
    commands.includes('kiro-usage'),
    'the extension registers the kiro-usage command',
  );

  const sessionStarted = handlers.get('session_start') ?? [];
  const sessionId = 'adapter-session';
  for (const handler of sessionStarted) {
    await handler(
      {},
      {
        sessionManager: { getSessionId: () => sessionId },
        model: undefined,
      },
    );
  }
  const routed = await provider.sessionManager.routeSession(
    { messages: [{ role: 'user', content: 'hi' }] } as any,
    { sessionId, cwd: '/tmp/kiro-acp-adapter' },
  );
  const session = routed.session;
  session.started = true;
  session.acpSessionId = 'acp-adapter';
  session.proc = {
    stdin: { end: () => true },
    once(_event: string, handler: () => void) {
      setImmediate(handler);
      return session.proc;
    },
  } as any;

  for (const handler of handlers.get('session_shutdown') ?? []) {
    await handler({ reason: 'quit' }, {});
  }
  assert(
    session.started === false && session.acpSessionId === null,
    'adapter shutdown stops the provider runtime it owns',
  );
});
