// Test: one keyed session id cannot take two routed streams, and a warm
// session that holds another transcript replays instead of reusing it.
// Run: npm test -- test/concurrent-routing.test.ts

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, test, vi } from 'vitest';

import { SessionManager } from '../src/session-manager.ts';
import { historyFingerprintBeforeCurrentUser } from '../src/session-persistence.ts';
import type { AcpSession } from '../src/session.ts';
import { streamKiroAcp } from '../src/stream.ts';
import { assert, kiroContext, kiroModel } from './support.ts';

const dataHome = mkdtempSync(join(tmpdir(), 'kiro-acp-routing-'));
vi.stubEnv('XDG_DATA_HOME', dataHome);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dataHome, { recursive: true, force: true });
});

const CWD = '/tmp/kiro-acp-routing';
const opts = (sessionId: string) => ({ sessionId, cwd: CWD });

/** A process that reports exit on stop and passes written frames on. */
function attachFakeProc(
  session: AcpSession,
  onWrite?: (frame: any) => void,
): void {
  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        onWrite?.(JSON.parse(chunk));
        return true;
      },
      end: () => true,
    },
    once(event: string, handler: () => void) {
      if (event === 'exit') setImmediate(handler);
      return session.proc;
    },
  } as any;
}

/** Answer each RPC frame through the session's own stdout parser. */
function attachRpcProc(
  session: AcpSession,
  resultFor: (frame: any) => { result?: unknown; error?: unknown },
): any[] {
  const frames: any[] = [];
  attachFakeProc(session, (frame) => {
    frames.push(frame);
    if (frame.id === undefined) return;
    const answer = resultFor(frame);
    setImmediate(() =>
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          ...(answer.error
            ? { error: answer.error }
            : { result: answer.result ?? {} }),
        }),
      ),
    );
  });
  return frames;
}

const toolResultContext = (toolCallId: string) =>
  ({
    messages: [
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: toolCallId,
            name: 'read',
            arguments: {},
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId,
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'done' }],
      },
    ],
    systemPrompt: '',
    tools: [],
  }) as any;

test('concurrent cold routes reserve the keyed slot', async () => {
  const manager = new SessionManager();
  try {
    const first = await manager.routeSession(kiroContext('one'), opts('S'));
    const second = await manager.routeSession(kiroContext('two'), opts('S'));
    assert(
      first.session !== second.session,
      'a second request does not share a session that is still reserved',
    );

    first.release();
    second.release();
    const reused = await manager.routeSession(kiroContext('three'), opts('S'));
    assert(
      reused.session === first.session,
      'a released primary slot is reused',
    );
  } finally {
    await manager.stopAllSessions();
  }
});

test('one route release keeps the other reservation', async () => {
  const manager = new SessionManager();
  try {
    const first = await manager.routeSession(kiroContext('one'), opts('S'));
    first.session.started = true;
    first.session.acpSessionId = 'acp-live';

    const orphaned = await manager.routeSession(
      toolResultContext('c1'),
      opts('S'),
    );
    assert(
      orphaned.session === first.session,
      'an orphaned result still finds its live owner',
    );
    assert(orphaned.kind === 'orphaned', 'the route is orphaned, not a prompt');

    orphaned.release();
    const whileReserved = await manager.routeSession(
      kiroContext('two'),
      opts('S'),
    );
    assert(
      whileReserved.session !== first.session,
      'one stream finalizer does not clear another reservation',
    );

    first.release();
    const afterRelease = await manager.routeSession(
      kiroContext('three'),
      opts('S'),
    );
    assert(
      afterRelease.session === first.session,
      'the slot returns after the last release',
    );
  } finally {
    await manager.stopAllSessions();
  }
});

test('a warm session with another history replays the transcript', async () => {
  const manager = new SessionManager();
  try {
    const title = await manager.routeSession(
      kiroContext('make a title'),
      opts('S'),
    );
    const session = title.session;
    attachFakeProc(session);
    session.started = true;
    session.acpSessionId = 'acp-title';
    session.currentModelId = 'm1';
    session.conversationFingerprint = 'title-history';

    const calls: { method: string; params: any }[] = [];
    (session as any).rpcSend = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'session/new') return { sessionId: 'acp-replay' };
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    };

    const context = kiroContext('main question');
    await session.startPrompt('m1', '', 'main question', [], {
      expectedHistoryFingerprint: historyFingerprintBeforeCurrentUser(context),
      checkWarmHistory: true,
      replayUserMessage: 'REPLAY main question',
    });

    assert(
      calls.some((call) => call.method === 'session/new'),
      'a mismatched warm session starts a fresh ACP session',
    );
    assert(
      session.acpSessionId === 'acp-replay',
      'the warm ACP session is not reused',
    );
    const newAt = calls.findIndex((call) => call.method === 'session/new');
    const modelAt = calls.findIndex(
      (call) => call.method === 'session/set_model',
    );
    assert(
      newAt >= 0 && modelAt > newAt,
      'the model is set after the fresh ACP session',
    );
    assert(
      calls[modelAt].params.sessionId === 'acp-replay' &&
        calls[modelAt].params.modelId === 'm1',
      'the model reset targets the fresh ACP session',
    );
    const prompt = calls.find((call) => call.method === 'session/prompt');
    assert(
      JSON.stringify(prompt?.params).includes('REPLAY main question'),
      'the supplied transcript is replayed',
    );
  } finally {
    await manager.stopAllSessions();
  }
});

test('a warm session with the same history is reused', async () => {
  const manager = new SessionManager();
  try {
    const routed = await manager.routeSession(
      kiroContext('previous'),
      opts('S'),
    );
    const session = routed.session;
    attachFakeProc(session);
    session.started = true;
    session.acpSessionId = 'acp-main';
    const context = kiroContext('next question');
    const expected = historyFingerprintBeforeCurrentUser(context);
    session.conversationFingerprint = expected;

    const calls: { method: string; params: any }[] = [];
    (session as any).rpcSend = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    };

    await session.startPrompt('m1', '', 'next question', [], {
      expectedHistoryFingerprint: expected,
      checkWarmHistory: true,
      replayUserMessage: 'REPLAY next question',
    });

    assert(
      !calls.some((call) => call.method === 'session/new'),
      'a matching warm session needs no fresh ACP session',
    );
    assert(session.acpSessionId === 'acp-main', 'the warm ACP session is kept');
    const prompt = calls.find((call) => call.method === 'session/prompt');
    const text = JSON.stringify(prompt?.params);
    assert(text.includes('next question'), 'the current user message is sent');
    assert(!text.includes('REPLAY'), 'no replay text is sent');
  } finally {
    await manager.stopAllSessions();
  }
});

test('the stream replays a mismatched warm session', async () => {
  const manager = new SessionManager();
  try {
    const title = await manager.routeSession(
      kiroContext('make a title'),
      opts('S-stream'),
    );
    const session = title.session;
    session.started = true;
    session.acpSessionId = 'acp-title';
    session.currentModelId = kiroModel().id;
    session.conversationFingerprint = historyFingerprintBeforeCurrentUser(
      kiroContext('make a title'),
    );
    const frames = attachRpcProc(session, (frame) => {
      if (frame.method === 'session/new')
        return { result: { sessionId: 'acp-replay' } };
      if (frame.method === 'session/prompt')
        return { result: { stopReason: 'end_turn' } };
      return {};
    });
    title.release();

    const context = kiroContext('main question');
    context.messages.unshift(
      { role: 'user', content: 'prior question' } as any,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior answer' }],
      } as any,
    );
    const events: string[] = [];
    for await (const event of streamKiroAcp(
      manager,
      kiroModel(),
      context,
      opts('S-stream'),
    ))
      events.push(event.type);

    assert(
      frames.some((frame) => frame.method === 'session/new'),
      'the stream starts a fresh ACP session',
    );
    const prompt = frames.find((frame) => frame.method === 'session/prompt');
    const text = JSON.stringify(prompt?.params);
    assert(
      text.includes('prior answer'),
      'the supplied prior transcript is replayed',
    );
    assert(
      text.includes('main question'),
      'the current user message is included',
    );
    assert(events.includes('done'), 'the replayed turn completes');
  } finally {
    await manager.stopAllSessions();
  }
});

test('a fatal RPC failure clears the warm prefix', async () => {
  const manager = new SessionManager();
  try {
    const routed = await manager.routeSession(
      kiroContext('previous'),
      opts('S-fatal'),
    );
    const session = routed.session;
    session.started = true;
    session.acpSessionId = 'acp-main';
    session.currentModelId = 'old-model';
    const context = kiroContext('next question');
    session.conversationFingerprint =
      historyFingerprintBeforeCurrentUser(context);
    const frames = attachRpcProc(session, (frame) =>
      frame.method === 'session/set_model'
        ? { error: { code: -32000, message: 'model refused' } }
        : {},
    );
    routed.release();

    const events: string[] = [];
    for await (const event of streamKiroAcp(
      manager,
      kiroModel(),
      context,
      opts('S-fatal'),
    ))
      events.push(event.type);

    assert(
      frames.some((frame) => frame.method === 'session/set_model'),
      'the model RPC was attempted',
    );
    assert(
      events.includes('error'),
      'the RPC failure ends the stream with an error',
    );
    assert(
      session.conversationFingerprint === null,
      'the fatal catch clears the recorded prefix',
    );
    const again = await manager.routeSession(
      kiroContext('again'),
      opts('S-fatal'),
    );
    assert(again.session === session, 'the released route can be reused');
    again.release();
  } finally {
    await manager.stopAllSessions();
  }
});
