// Test: the opt-in Kiro V3 engine — launch flags, agent profile, session
// params, the advertised-extension gate and the unimplemented turn path.
// Drives a real AcpSession against a fake `kiro-cli` ACP server (the real CLI
// spends credits, so it is never started here).
// Run: npm test -- test/agent-engine.test.ts

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, vi } from 'vitest';

import {
  loadPersistedKiroSession,
  savePersistedKiroSession,
} from '../src/session-persistence.ts';
import { AcpSession } from '../src/session.ts';
import type { ForwardedToolCatalog } from '../src/tool-catalog.ts';
import { assert, kiroContext, settled, wait } from './support.ts';

const V2_ONLY_FLAGS = [
  '--agent',
  '--model',
  '--effort',
  '--trust-all-tools',
  '--trust-tools',
];

const catalogProvider = (): ForwardedToolCatalog => ({
  tools: [],
  piNameByKiroName: new Map<string, string>(),
  fingerprint: 'agent-engine-test',
  diagnostics: [],
});

/** Loads a fresh `session.ts`, so module state (the one-shot MCP-timeout flag)
 * starts clean instead of depending on which test ran first. */
async function freshSessionModule() {
  vi.resetModules();
  return import('../src/session.ts');
}

/** Waits until the fake has logged everything written before this marker, so a
 * "frame X was not sent" assertion cannot pass on unread bytes. */
async function quiesce(session: AcpSession, fake: FakeKiroCli): Promise<void> {
  await session.rpcSend('test/marker', {});
  await waitFor(() => fake.frames().some((f) => f.method === 'test/marker'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('timed out waiting for condition');
}

interface FakeKiroCli {
  /** argv of every invocation, `settings …` ones included. */
  invocations: () => string[][];
  /** Every JSON-RPC frame the fake received, in order. */
  frames: () => any[];
  /** Client messages that are not requests (i.e. answers to the fake). */
  replies: () => any[];
  restore: () => void;
}

function readLog(dir: string, name: string): any[] {
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Puts the fake on PATH as `kiro-cli` and points it at a scratch log dir.
 * `modes` overrides the mode the fake reports for session/new or session/load;
 * unset, it echoes the requested `_meta.kiro.modeId` like a working profile. */
function fakeKiroCli(
  extensionMethods: string[] = [],
  modes: { new?: string; load?: string } = {},
): FakeKiroCli {
  const root = mkdtempSync(join(tmpdir(), 'kiro-acp-engine-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'log');
  mkdirSync(binDir);
  mkdirSync(logDir);
  const executable = join(binDir, 'kiro-cli');
  copyFileSync(
    new URL('./fixtures/fake-kiro-acp.cjs', import.meta.url),
    executable,
  );
  chmodSync(executable, 0o755);

  const savedPath = process.env.PATH;
  const savedDir = process.env.FAKE_KIRO_DIR;
  const savedMethods = process.env.FAKE_KIRO_EXTENSION_METHODS;
  const savedNewMode = process.env.FAKE_KIRO_NEW_MODE;
  const savedLoadMode = process.env.FAKE_KIRO_LOAD_MODE;
  process.env.PATH = `${binDir}:${savedPath ?? ''}`;
  process.env.FAKE_KIRO_DIR = logDir;
  process.env.FAKE_KIRO_EXTENSION_METHODS = JSON.stringify(extensionMethods);
  setEnv('FAKE_KIRO_NEW_MODE', modes.new);
  setEnv('FAKE_KIRO_LOAD_MODE', modes.load);

  return {
    invocations: () => readLog(logDir, 'invocations.log'),
    frames: () => readLog(logDir, 'frames.log'),
    replies: () => readLog(logDir, 'replies.log'),
    restore() {
      process.env.PATH = savedPath;
      if (savedDir === undefined) delete process.env.FAKE_KIRO_DIR;
      else process.env.FAKE_KIRO_DIR = savedDir;
      if (savedMethods === undefined)
        delete process.env.FAKE_KIRO_EXTENSION_METHODS;
      else process.env.FAKE_KIRO_EXTENSION_METHODS = savedMethods;
      setEnv('FAKE_KIRO_NEW_MODE', savedNewMode);
      setEnv('FAKE_KIRO_LOAD_MODE', savedLoadMode);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Spawned `acp` invocations without the `-v…` verbosity suffix, which comes
 * from the local kiro-acp.json and is not what these tests are about. */
function acpInvocations(invocations: string[][]): string[][] {
  return invocations
    .filter((argv) => argv[0] === 'acp')
    .map((argv) => argv.filter((arg) => !/^-v+$/.test(arg)));
}

function frameParams(frames: any[], method: string): any {
  return frames.find((frame) => frame.method === method)?.params;
}

test('v3 launches with the engine flags and a pi-only agent profile', async () => {
  const { AcpSession: FreshSession } = await freshSessionModule();
  const fake = fakeKiroCli(['_session/steer']);
  const session = new FreshSession(process.cwd(), 'v3');
  try {
    await session.ensureStarted(catalogProvider);

    const invocations = fake.invocations();
    const acp = acpInvocations(invocations);
    assert(acp.length === 1, 'exactly one acp process started');
    assert(
      acp[0].join(' ') === 'acp --agent-engine=v3 --auth-method=cli',
      `v3 args are the engine flags only (got "${acp[0].join(' ')}")`,
    );
    assert(
      !acp[0].some((arg) => V2_ONLY_FLAGS.includes(arg)),
      'no v2-only flag is passed to v3',
    );
    assert(
      !invocations.some((argv) => argv[0] === 'settings'),
      'a v3 start does not run `kiro-cli settings`',
    );

    const profile = JSON.parse(readFileSync(session.agentConfigPath, 'utf8'));
    assert(
      JSON.stringify(profile.tools) === JSON.stringify(['@pi_host']),
      'the profile exposes only the pi_host server',
    );
    assert(
      profile.allowedTools === undefined &&
        profile.excludedTools === undefined &&
        profile.toolsSettings === undefined,
      'no profile field V3 rejects or that breaks MCP access',
    );
    assert(
      JSON.stringify(profile.permissions) ===
        JSON.stringify({
          rules: [
            { capability: 'mcp', match: ['pi_host/*'], effect: 'allow' },
            { capability: 'builtin', effect: 'deny' },
          ],
        }),
      'the permission rules allow pi_host and deny builtins',
    );
    assert(
      profile.includeMcpJson === false &&
        JSON.stringify(profile.mcpServers) === '{}',
      'no MCP servers are taken from the workspace',
    );
    assert(
      typeof profile.prompt === 'string' &&
        profile.prompt.includes('pi_host tools'),
      'the profile carries the agent prompt',
    );
  } finally {
    await session.stop();
    fake.restore();
  }
});

test('the default engine keeps the v2 launch flags', async () => {
  const { AcpSession: FreshSession } = await freshSessionModule();
  const fake = fakeKiroCli();
  const session = new FreshSession(process.cwd());
  try {
    assert(session.engine === 'v2', 'a session without an engine runs v2');
    await session.ensureStarted(catalogProvider);

    const acp = acpInvocations(fake.invocations());
    assert(acp.length === 1, 'exactly one acp process started');
    assert(
      acp[0].join(' ') ===
        ['acp', '--agent', session.agentName, '--trust-tools', '@pi_host'].join(
          ' ',
        ),
      `v2 args are unchanged (got "${acp[0].join(' ')}")`,
    );
    assert(
      fake.invocations().filter((argv) => argv[0] === 'settings').length === 1,
      'a v2 start still configures the MCP timeout',
    );
  } finally {
    await session.stop();
    fake.restore();
  }
});

test('v3 session/new selects the agent through the session workspace', async () => {
  const fake = fakeKiroCli();
  const cwd = mkdtempSync(join(tmpdir(), 'kiro-acp-project-'));
  const session = new AcpSession(cwd, 'v3');
  try {
    await session.ensureStarted(catalogProvider);
    // Straight to the handshake: startPrompt fails fast on v3 by design.
    await (session as any).ensureBackendSession({});

    const params = frameParams(fake.frames(), 'session/new');
    assert(!!params, 'session/new was sent');
    assert(params.cwd === cwd, 'the session runs in the project cwd');
    assert(
      JSON.stringify(params.additionalDirectories) ===
        JSON.stringify([session.agentRootPath]),
      'the profile directory is declared as an additional directory',
    );
    assert(
      params._meta?.kiro?.modeId === session.agentName,
      'the agent profile is named as the mode',
    );
    assert(
      params.mcpServers?.[0]?.name === 'pi_host' &&
        params.mcpServers[0].url === session.toolBridge?.url,
      'the pi_host bridge rides in the session params',
    );
    assert(
      session.acpSessionId === 'fake-session',
      'a session created in our mode is adopted',
    );
  } finally {
    await session.stop();
    fake.restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('v3 session/load restores with the same agent selection', async () => {
  const fake = fakeKiroCli();
  const dataHome = mkdtempSync(join(tmpdir(), 'kiro-acp-data-'));
  const savedDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  const cwd = mkdtempSync(join(tmpdir(), 'kiro-acp-project-'));
  const session = new AcpSession(cwd, 'v3');
  session.persistenceKey = 'agent-engine/v3-load';
  try {
    await session.ensureStarted(catalogProvider);
    savePersistedKiroSession(session.persistenceKey, {
      version: 1,
      kiroSessionId: 'persisted-v3',
      historyFingerprint: 'history-hash',
      agentConfigFingerprint: session.agentConfigFingerprint!,
      modelId: 'auto',
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });

    await (session as any).ensureBackendSession({
      expectedHistoryFingerprint: 'history-hash',
    });

    const params = frameParams(fake.frames(), 'session/load');
    assert(!!params, 'session/load was sent');
    assert(
      params.sessionId === 'persisted-v3',
      'the persisted kiro session is loaded',
    );
    assert(
      JSON.stringify(params.additionalDirectories) ===
        JSON.stringify([session.agentRootPath]),
      'the restore declares the profile directory too',
    );
    assert(
      params._meta?.kiro?.modeId === session.agentName,
      'the restore names the agent profile as the mode',
    );
    assert(
      params.mcpServers?.[0]?.name === 'pi_host' &&
        params.mcpServers[0].url === session.toolBridge?.url,
      'the restore carries the pi_host bridge',
    );
    assert(
      !fake.frames().some((frame) => frame.method === 'session/new'),
      'a successful restore creates no fresh session',
    );
    assert(
      session.acpSessionId === 'persisted-v3',
      'a load that reports our mode is adopted',
    );
  } finally {
    await session.stop();
    fake.restore();
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    rmSync(dataHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a v3 session/new that lands in the vibe mode is refused', async () => {
  const fake = fakeKiroCli([], { new: 'vibe' });
  const session = new AcpSession(process.cwd(), 'v3');
  try {
    await session.ensureStarted(catalogProvider);
    const handshake = await settled((session as any).ensureBackendSession({}));

    assert(!handshake.ok, 'the handshake rejects');
    assert(
      handshake.error?.message ===
        `Kiro V3 did not select agent ${session.agentName} (mode: vibe); refusing a session with Kiro built-in tools`,
      `the error names the actual mode (got "${handshake.error?.message}")`,
    );
    assert(
      session.acpSessionId === null,
      'the session running Kiro built-ins is not adopted',
    );
  } finally {
    await session.stop();
    fake.restore();
  }
});

test('a v3 session/load that lands in the vibe mode is dropped for a fresh session', async () => {
  const fake = fakeKiroCli([], { load: 'vibe' });
  const dataHome = mkdtempSync(join(tmpdir(), 'kiro-acp-data-'));
  const savedDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
  const session = new AcpSession(process.cwd(), 'v3');
  session.persistenceKey = 'agent-engine/v3-load-vibe';
  try {
    await session.ensureStarted(catalogProvider);
    savePersistedKiroSession(session.persistenceKey, {
      version: 1,
      kiroSessionId: 'persisted-vibe',
      historyFingerprint: 'history-hash',
      agentConfigFingerprint: session.agentConfigFingerprint!,
      modelId: 'auto',
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });

    const replay = await (session as any).ensureBackendSession({
      expectedHistoryFingerprint: 'history-hash',
    });

    assert(replay === true, "the history is replayed from pi's transcript");
    assert(
      loadPersistedKiroSession(session.persistenceKey) === null,
      'the record that restores a Kiro-builtin mode is dropped',
    );
    assert(
      !!frameParams(fake.frames(), 'session/load'),
      'the stored session was loaded first',
    );
    assert(
      !!frameParams(fake.frames(), 'session/new'),
      'a fresh session follows the refused restore',
    );
    assert(
      session.acpSessionId === 'fake-session',
      'the fresh session in our mode is adopted',
    );
  } finally {
    await session.stop();
    fake.restore();
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test('an unknown agent-to-client request gets an error on v3 and null on v2', async () => {
  const v3Fake = fakeKiroCli();
  const v3Session = new AcpSession(process.cwd(), 'v3');
  try {
    await v3Session.ensureStarted(catalogProvider);
    // session/new is what makes the fake send the unknown request.
    await (v3Session as any).ensureBackendSession({});
    await waitFor(() => v3Fake.replies().length > 0);
    const [reply] = v3Fake.replies();
    assert(
      reply.error?.code === -32601 && reply.result === undefined,
      `v3 gets a method-not-found error (got ${JSON.stringify(reply)})`,
    );
  } finally {
    await v3Session.stop();
    v3Fake.restore();
  }

  const v2Fake = fakeKiroCli();
  const v2Session = new AcpSession(process.cwd());
  try {
    await v2Session.ensureStarted(catalogProvider);
    await v2Session.startPrompt('auto', '', 'hi');
    await waitFor(() => v2Fake.replies().length > 0);
    const [reply] = v2Fake.replies();
    assert(
      reply.result === null && reply.error === undefined,
      `v2 still answers with a null result (got ${JSON.stringify(reply)})`,
    );
  } finally {
    await v2Session.stop();
    v2Fake.restore();
  }
});

test('supportsExtension follows the methods advertised in initialize', async () => {
  const fake = fakeKiroCli(['_session/steer', '_kiro/memory/getSyncStatus']);
  const session = new AcpSession(process.cwd(), 'v3');
  try {
    await session.ensureStarted(catalogProvider);
    assert(
      session.supportsExtension('_session/steer'),
      'an advertised extension method is supported',
    );
    assert(
      !session.supportsExtension('_session/unadvertised'),
      'a method the backend did not advertise is not supported',
    );
  } finally {
    await session.stop();
    fake.restore();
  }
});

test('the v3 turn path fails fast instead of sending a v2 model RPC', async () => {
  const fake = fakeKiroCli();
  const session = new AcpSession(process.cwd(), 'v3');
  try {
    await session.ensureStarted(catalogProvider);
    const turn = await settled(
      session.startPrompt('claude-sonnet-4.6', '', 'hi'),
    );
    assert(!turn.ok, 'startPrompt rejects on v3');
    assert(
      turn.error?.message === 'Kiro V3 turn path not implemented yet',
      `the error names the gap (got "${turn.error?.message}")`,
    );
    await quiesce(session, fake);
    assert(
      !fake
        .frames()
        .some((frame) =>
          [
            'session/new',
            'session/load',
            'session/set_model',
            'session/prompt',
          ].includes(frame.method),
        ),
      'a failing v3 turn does no backend I/O',
    );

    // The process stays alive after that failed turn; a level on the next turn
    // must not turn into a v2 `/effort` command prompt.
    await session.ensureStarted(catalogProvider, 'high');
    await quiesce(session, fake);
    assert(
      !fake.frames().some((frame) => frame.method === 'session/prompt'),
      'a started v3 session sends no /effort command prompt',
    );
  } finally {
    await session.stop();
    fake.restore();
  }
});

test('the engine from kiro-acp.json reaches the routed session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kiro-acp-home-'));
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'kiro-acp.json'),
    JSON.stringify({ agentEngine: 'v3' }),
  );
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    vi.resetModules();
    const { SessionManager } = await import('../src/session-manager.ts');
    const manager = new SessionManager();
    try {
      // Routing only: nothing is spawned, so no kiro-cli is involved.
      const routed = await manager.routeSession(kiroContext('hi'), {
        cwd: process.cwd(),
      });
      assert(
        routed.session.engine === 'v3',
        `the routed session runs the configured engine (got ${routed.session.engine})`,
      );
    } finally {
      await manager.stopAllSessions();
    }
  } finally {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});
