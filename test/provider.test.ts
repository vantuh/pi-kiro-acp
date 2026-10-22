// Test: the native pi-ai provider works standalone through createModels.
// Run: npm test -- test/provider.test.ts

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModels, normalizeContext } from '@earendil-works/pi-ai';
import { test } from 'vitest';

import { abortable, discoverKiroModels } from '../src/models/discovery.ts';
import { KIRO_ACP_PROVIDER } from '../src/overflow.ts';
import { createKiroAcpProvider } from '../src/provider.ts';
import { SessionManager } from '../src/session-manager.ts';
import { AcpSession } from '../src/session.ts';
import { streamKiroAcp } from '../src/stream.ts';
import { assert, kiroContext, kiroModel, settled } from './support.ts';

const CWD = '/tmp/kiro-acp-provider';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('timed out waiting for condition');
}

test('standalone provider registers in createModels and streams', async () => {
  const provider = createKiroAcpProvider();
  const models = createModels();
  models.setProvider(provider);

  try {
    assert(
      models.getProvider(KIRO_ACP_PROVIDER) === provider,
      'createModels keeps the native provider',
    );

    await models.refresh({ force: true });
    const catalog = provider.getModels();
    assert(catalog.length > 0, 'provider refresh discovers a model catalog');
    assert(
      catalog.every((model) => model.provider === KIRO_ACP_PROVIDER),
      'discovered models carry the provider id',
    );

    const model = catalog[0];
    const auth = await models.getAuth(model);
    assert(
      auth?.source === 'kiro-cli',
      'ambient kiro-cli auth resolves without a key',
    );

    const context = kiroContext('Say hello.');
    const routed = await provider.sessionManager.routeSession(context, {
      sessionId: 'S-standalone',
      cwd: CWD,
    });
    const session = routed.session;
    const written: any[] = [];
    session.proc = {
      stdin: {
        writable: true,
        write(chunk: string) {
          written.push(JSON.parse(chunk));
          return true;
        },
        end() {
          return true;
        },
      },
      once(event: string, handler: () => void) {
        if (event === 'exit') setImmediate(handler);
        return session.proc;
      },
    } as any;
    session.acpSessionId = 'acp-standalone';
    session.currentModelId = model.id;
    session.started = true;

    const events: string[] = [];
    let text = '';
    const consumed = (async () => {
      for await (const event of models.streamSimple(model, context, {
        sessionId: 'S-standalone',
        cwd: CWD,
      } as any)) {
        events.push(
          event.type === 'done' ? `done:${(event as any).reason}` : event.type,
        );
        if (event.type === 'text_delta') text += (event as any).delta;
      }
    })();

    await waitFor(() =>
      written.some((frame) => frame.method === 'session/prompt'),
    );
    const prompt = written.find((frame) => frame.method === 'session/prompt');
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-standalone',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello' },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: prompt.id,
        result: { stopReason: 'end_turn' },
      }),
    );
    await consumed;

    assert(events.includes('done:stop'), 'the standalone turn completes');
    assert(text.includes('hello'), 'text reaches the Models stream');
  } finally {
    await provider.close();
  }
});

test('anonymous prompts do not reuse an idle session', async () => {
  const manager = new SessionManager();
  const first = await manager.routeSession(kiroContext('one'), { cwd: CWD });
  const second = await manager.routeSession(kiroContext('two'), { cwd: CWD });
  assert(
    first.session !== second.session,
    'a new anonymous prompt gets a fresh ACP session',
  );
  await manager.stopAllSessions();
});

test('a missing route becomes a stream error, not a throw', async () => {
  const provider = createKiroAcpProvider({
    resolveSessionManager: () => {
      throw new Error('No kiro-acp runtime registered for session missing');
    },
  });
  const model = provider.getModels()[0];
  const stream = provider.streamSimple(
    model,
    normalizeContext(kiroContext('hi')),
    { sessionId: 'missing' },
  );
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  const error = events.find((event) => event.type === 'error');
  assert(!!error, 'the stream reports an error');
  assert(
    error.error.errorMessage.includes('No kiro-acp runtime registered'),
    'the stream error carries the routing failure',
  );
  await provider.close();
});

function fakeKiroCli(): {
  dir: string;
  pidFile: string;
  restore: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-acp-fake-'));
  const pidFile = join(dir, 'pid');
  const executable = join(dir, 'kiro-cli');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_KIRO_PID_FILE, String(process.pid) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`,
  );
  chmodSync(executable, 0o755);
  const oldPath = process.env.PATH;
  const oldPidFile = process.env.FAKE_KIRO_PID_FILE;
  process.env.PATH = `${dir}:${oldPath ?? ''}`;
  process.env.FAKE_KIRO_PID_FILE = pidFile;
  return {
    dir,
    pidFile,
    restore() {
      process.env.PATH = oldPath;
      if (oldPidFile === undefined) delete process.env.FAKE_KIRO_PID_FILE;
      else process.env.FAKE_KIRO_PID_FILE = oldPidFile;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFakePids(pidFile: string, count = 1): Promise<number[]> {
  await waitFor(() => {
    if (!existsSync(pidFile)) return false;
    return readFileSync(pidFile, 'utf8').trim().split('\n').length >= count;
  }, 3000);
  return readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
}

test('abort during discovery rejects and stops the child', async () => {
  const fake = fakeKiroCli();
  try {
    const controller = new AbortController();
    const discovery = discoverKiroModels(process.cwd(), controller.signal);
    const [pid] = await waitForFakePids(fake.pidFile);
    controller.abort();
    const result = await settled(discovery);
    assert(!result.ok, 'discovery rejects on abort');
    assert(
      result.error?.name === 'AbortError',
      'discovery rejects with an abort error',
    );
    await waitFor(() => !processAlive(pid), 3000);
    assert(!processAlive(pid), 'abort stops the discovery child');
  } finally {
    fake.restore();
  }
});

test('abort after the request starts observes its late rejection', async () => {
  const controller = new AbortController();
  controller.abort();
  let failRequest!: (error: Error) => void;
  const request = new Promise((_resolve, reject) => {
    failRequest = reject;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await settled(abortable(request, controller.signal));
    assert(
      result.error?.name === 'AbortError',
      'an already-aborted signal rejects with an abort error',
    );
    // The abandoned RPC rejects once discovery stops its child process.
    failRequest(new Error('kiro-cli exited during model discovery'));
    await wait(20);
    assert(
      unhandled.length === 0,
      'the abandoned request rejection is observed',
    );
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('close during discovery aborts every child and skips publication', async () => {
  const fake = fakeKiroCli();
  let published = 0;
  const provider = createKiroAcpProvider();
  const refresh = () =>
    provider.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: async ({ update }) => {
        published += 1;
        update?.();
        return true;
      },
    });
  try {
    const first = settled(refresh());
    const second = settled(refresh());
    const pids = await waitForFakePids(fake.pidFile, 2);
    await provider.close();
    await Promise.all([first, second]);
    await waitFor(() => pids.every((pid) => !processAlive(pid)), 3000);
    assert(
      pids.every((pid) => !processAlive(pid)),
      'close stops every discovery child',
    );
    assert(published === 0, 'close prevents a late catalog publication');
  } finally {
    await provider.close();
    fake.restore();
  }
});

test('close waits for startup and rejects later sessions', async () => {
  const manager = new SessionManager();
  const routedSession = await manager.routeSession(kiroContext('x'), {
    cwd: '/tmp',
  });
  const session = routedSession.session;
  let releaseStartup!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  (session as any).ensureStarted = async () => {
    await gate;
    session.started = true;
  };
  let stopCount = 0;
  const stop = session.stop.bind(session);
  (session as any).stop = async () => {
    stopCount += 1;
    await stop();
  };

  const startup = manager.startSession(
    session,
    () => ({ tools: [] }) as any,
    null,
  );
  const closing = manager.close();
  let closeDone = false;
  void closing.then(() => {
    closeDone = true;
  });
  await wait(20);
  assert(!closeDone, 'close waits for an in-flight startup');

  releaseStartup();
  const startupResult = await settled(startup);
  assert(!startupResult.ok, 'the in-flight startup fails after close');
  await closing;
  assert(closeDone, 'close resolves after the startup settles');
  assert(session.started === false, 'close stops the started session');
  assert(stopCount === 1, 'close owns the only stop of the raced session');

  const later = await settled(
    manager.startSession(
      new AcpSession('/tmp'),
      () => ({ tools: [] }) as any,
      null,
    ),
  );
  assert(!later.ok, 'startSession after close is rejected');
  const routed = await settled(manager.routeSession(kiroContext('x')));
  assert(!routed.ok, 'routeSession after close is rejected');
});

test('a terminal anonymous stream releases its session', async () => {
  const session = new AcpSession('/tmp');
  session.persistenceKey = null;
  session.acpSessionId = 'acp-anon';
  session.currentModelId = 'claude-sonnet-4.6';
  session.started = true;
  const written: any[] = [];
  let exited = false;
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        written.push(JSON.parse(chunk));
        return true;
      },
      end() {
        exited = true;
        return true;
      },
    },
    once(event: string, handler: () => void) {
      if (event === 'exit') setImmediate(handler);
      return session.proc;
    },
  } as any;

  let released: AcpSession | null = null;
  const manager = {
    pruneIdleSessions() {},
    routeSession: async () => ({ session, toolResults: [], kind: 'prompt' }),
    startSession: async (target: AcpSession, catalog: any, effort: any) =>
      target.ensureStarted(catalog, effort),
    releaseSession(target: AcpSession) {
      released = target;
      void target.stop();
    },
  } as any;

  const consumed = (async () => {
    for await (const _event of streamKiroAcp(
      manager,
      kiroModel(),
      kiroContext('hi'),
      { cwd: '/tmp' },
    )) {
      // Drain the stream.
    }
  })();

  await waitFor(() =>
    written.some((frame) => frame.method === 'session/prompt'),
  );
  const prompt = written.find((frame) => frame.method === 'session/prompt');
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: prompt.id,
      result: { stopReason: 'end_turn' },
    }),
  );
  await consumed;
  await waitFor(() => exited, 3000);

  assert(released === session, 'a terminal anonymous session is released');
  assert(exited, 'release stops the anonymous process');
});

test('close waits for a released session teardown', async () => {
  const manager = new SessionManager();
  const session = new AcpSession('/tmp');
  let finishTeardown!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishTeardown = resolve;
  });
  (session as any).stop = () => gate;

  manager.releaseSession(session);
  const closing = manager.close();
  let closeDone = false;
  void closing.then(() => {
    closeDone = true;
  });
  await wait(20);
  assert(!closeDone, 'close waits for a released session teardown');

  finishTeardown();
  await closing;
  assert(closeDone, 'close resolves after the teardown');
});

test('an anonymous prompt failure releases its session', async () => {
  const session = new AcpSession('/tmp');
  session.persistenceKey = null;
  session.acpSessionId = 'acp-anon-fail';
  session.currentModelId = 'claude-sonnet-4.6';
  session.started = true;
  (session as any).startPrompt = async () => {
    throw new Error('prompt failed before streaming');
  };

  let released: AcpSession | null = null;
  const manager = {
    pruneIdleSessions() {},
    routeSession: async () => ({ session, toolResults: [], kind: 'prompt' }),
    startSession: async (target: AcpSession, catalog: any, effort: any) =>
      target.ensureStarted(catalog, effort),
    releaseSession(target: AcpSession) {
      released = target;
      void target.stop();
    },
  } as any;

  const events: string[] = [];
  for await (const event of streamKiroAcp(
    manager,
    kiroModel(),
    kiroContext('hi'),
    { cwd: '/tmp' },
  )) {
    events.push(event.type);
  }

  assert(events.includes('error'), 'the prompt failure ends the stream');
  assert(
    released === session,
    'a terminal anonymous failure releases its session',
  );
  assert(session.started === false, 'the failed session is stopped');
});

test('a failed anonymous stream keeps a pending tool continuation', async () => {
  const session = new AcpSession('/tmp');
  session.persistenceKey = null;
  session.acpSessionId = 'acp-anon-pending';
  session.currentModelId = 'claude-sonnet-4.6';
  session.started = true;
  session.pendingToolCalls.set('call-1', {
    callId: 'call-1',
    toolName: 'bash',
    args: {},
    resolve: () => {},
    receivedAt: Date.now(),
  });
  (session as any).startPrompt = async () => {
    throw new Error('fatal before the prompt started');
  };

  let released = false;
  const manager = {
    pruneIdleSessions() {},
    routeSession: async () => ({ session, toolResults: [], kind: 'prompt' }),
    startSession: async (target: AcpSession, catalog: any, effort: any) =>
      target.ensureStarted(catalog, effort),
    releaseSession() {
      released = true;
    },
  } as any;

  for await (const _event of streamKiroAcp(
    manager,
    kiroModel(),
    kiroContext('hi'),
    { cwd: '/tmp' },
  )) {
    // Drain the stream.
  }

  assert(!released, 'a pending tool continuation keeps the session');
  assert(session.started === true, 'the pending session is not stopped');
});
