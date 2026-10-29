// Test: a turn's request signal cannot cancel Kiro after that turn ends, and a
// cancelled turn is reported as aborted instead of ending as a finished turn.
// Durable aborts each invocation's signal when its request phase ends; the
// stream must drop the listener then, or it cancels Kiro while pi runs the tool.
// Run: npm test -- test/request-signal.test.ts

process.env.PI_KIRO_ACP_TOOL_BATCH_MS = '5';

import { beforeEach, test, vi } from 'vitest';

// Session persistence is an in-memory store, so no test reads or writes the
// real XDG data dir and an earlier turn's snapshot can be seeded.
const store = vi.hoisted(() => new Map<string, any>());

vi.mock('../src/session-persistence.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadPersistedKiroSession: vi.fn((key: string) => store.get(key) ?? null),
  savePersistedKiroSession: vi.fn((key: string, record: unknown) => {
    store.set(key, record);
  }),
  clearPersistedKiroSession: vi.fn((key: string) => {
    store.delete(key);
  }),
}));

import { SessionManager } from '../src/session-manager.ts';
import {
  clearPersistedKiroSession,
  historyFingerprintAfterAssistantTurn,
  historyFingerprintBeforeCurrentUser,
  savePersistedKiroSession,
} from '../src/session-persistence.ts';
import { assert, kiroContext, kiroModel, wait } from './support.ts';

// Imported after the env override so the debounce is picked up.
const { streamKiroAcp } = await import('../src/stream.ts');

const CWD = '/tmp/kiro-acp-request-signal';
const model = kiroModel();
const persistedSaves = vi.mocked(savePersistedKiroSession);
const persistedClears = vi.mocked(clearPersistedKiroSession);

beforeEach(() => {
  persistedSaves.mockClear();
  persistedClears.mockClear();
  store.clear();
});

/** Wait until `condition` holds, up to a bound. */
async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await wait(5);
  }
}

/** One text delta from Kiro on the fake conversation. */
function textChunk(session: any, text: string) {
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: session.acpSessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      },
    }),
  );
}

/** Answers session/new the way kiro-cli does: the requested agent, already on
 * the model this turn runs, so no config RPC is needed before the prompt. */
function answerSessionNew(session: any, frame: any, acpSessionId: string) {
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        sessionId: acpSessionId,
        modes: { currentModeId: session.agentName },
        configOptions: [
          {
            id: 'model',
            currentValue: model.id,
            options: [{ value: model.id, name: model.id }],
          },
        ],
      },
    }),
  );
}

function eventSummary(event: any): string {
  if (event.type === 'error') return `error:${event.reason}`;
  if (event.type === 'done') return `done:${event.reason}`;
  return event.type;
}

/** A routed session that captures ACP writes instead of spawning kiro-cli. */
async function fakeTurnSession(
  sessionManager: SessionManager,
  sessionId: string,
) {
  const opts = { sessionId, cwd: CWD };
  const routed = await sessionManager.routeSession(
    kiroContext('read notes.md'),
    opts,
  );
  const written: any[] = [];
  const { session } = routed;
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
  session.acpSessionId = 'acp-1';
  session.currentModelId = model.id;
  session.started = true;
  session.conversationFingerprint = historyFingerprintBeforeCurrentUser(
    kiroContext('read notes.md'),
  );
  // The stream routes again; free this pre-route so it takes this session.
  routed.release();
  return { session, opts, written };
}

/** The context pi hands back once the tool has run. */
const resultContext = (toolCallId: string) => {
  const context = kiroContext('read notes.md');
  context.messages.push(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: toolCallId,
          name: 'read',
          arguments: { path: 'notes.md' },
        },
      ],
    } as any,
    {
      role: 'toolResult',
      toolCallId,
      toolName: 'read',
      isError: false,
      content: [{ type: 'text', text: 'the notes say hi' }],
    } as any,
  );
  return context;
};

test('an ended turn signal cannot cancel the tool it asked for', async () => {
  const sessionManager = new SessionManager();

  try {
    const { session, opts, written } = await fakeTurnSession(
      sessionManager,
      'S-signal',
    );

    // Turn 1 asks for a tool, then ends.
    const request = new AbortController();
    const firstEvents: string[] = [];
    const first = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        kiroContext('read notes.md'),
        { ...opts, signal: request.signal },
      )) {
        firstEvents.push(
          event.type === 'done' ? `done:${(event as any).reason}` : event.type,
        );
      }
    })();
    await until(() => firstEvents.includes('start'), 'turn 1 starts');
    const promptFrame = written.find(
      (frame) => frame.method === 'session/prompt',
    );
    assert(!!promptFrame, 'the first prompt is sent');

    const toolCall = (session as any).handleBridgeToolCall({
      kiroName: 'read',
      piName: 'read',
      arguments: { path: 'notes.md' },
      signal: new AbortController().signal,
    }) as Promise<{ content: { text?: string }[]; isError?: boolean }>;
    const [toolCallId] = [...session.pendingToolCalls.keys()];
    assert(!!toolCallId, 'Kiro asks for the tool through the bridge');

    await first;
    assert(
      firstEvents.includes('done:toolUse'),
      `the turn ends with toolUse (got ${firstEvents.join(',')})`,
    );

    // Turn 2 answers that call. While it runs, turn 1's ended signal aborts.
    const secondEvents: string[] = [];
    let text = '';
    const second = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        resultContext(toolCallId),
        { ...opts, signal: new AbortController().signal },
      )) {
        secondEvents.push(
          event.type === 'done' ? `done:${(event as any).reason}` : event.type,
        );
        if (event.type === 'text_delta') text += (event as any).delta;
      }
    })();
    await until(() => secondEvents.includes('start'), 'turn 2 starts');

    request.abort();
    assert(
      !written.some((frame) => frame.method === 'session/cancel'),
      'the ended turn signal does not cancel Kiro',
    );
    const answer = await toolCall;

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'acp-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'the notes say hi' },
          },
        },
      }),
    );
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptFrame.id,
        result: { stopReason: 'end_turn' },
      }),
    );
    await second;

    assert(
      answer.isError !== true,
      'the tool result answers the call Kiro still holds',
    );
    assert(
      written.filter((frame) => frame.method === 'session/prompt').length === 1,
      'no recovery prompt is needed',
    );
    assert(
      text.includes('the notes say hi'),
      `the response reaches pi (got "${text}")`,
    );
    assert(
      secondEvents.includes('done:stop'),
      `the second turn ends normally (got ${secondEvents.join(',')})`,
    );
    assert(
      persistedSaves.mock.calls.length === 1,
      'a finished turn is persisted',
    );
  } finally {
    await sessionManager.stopAllSessions();
  }
});

test('a cancelled turn ends aborted and drops the snapshot it can no longer resume', async () => {
  const sessionManager = new SessionManager();

  try {
    const { session, opts, written } = await fakeTurnSession(
      sessionManager,
      'S-active',
    );
    // An earlier turn persisted this ACP session. Its fingerprint is exactly
    // the prefix the next request carries once the aborted partial is dropped,
    // so a surviving snapshot would resume the cancelled conversation.
    const earlier = kiroContext('read notes.md').messages[0];
    const earlierAnswer = {
      role: 'assistant',
      content: [{ type: 'text', text: 'the notes say hi' }],
    } as any;
    const earlierFingerprint = historyFingerprintAfterAssistantTurn(
      kiroContext('read notes.md'),
      earlierAnswer,
    );
    session.conversationFingerprint = earlierFingerprint;
    session.agentConfigFingerprint = 'agent-config';
    (session as any).agentCapabilities = { loadSession: true };
    store.set(session.persistenceKey!, {
      version: 1,
      kiroSessionId: 'acp-1',
      historyFingerprint: earlierFingerprint,
      agentConfigFingerprint: 'agent-config',
      modelId: model.id,
      createdAt: Date.now(),
      lastUsed: Date.now(),
    });

    const cancelledContext = kiroContext('and then?');
    cancelledContext.messages.unshift(earlier, earlierAnswer);
    const request = new AbortController();
    const events: any[] = [];
    const stream = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        cancelledContext,
        { ...opts, signal: request.signal },
      )) {
        events.push(event);
      }
    })();
    await until(() => events.length > 0, 'the turn starts');
    const promptFrame = written.find(
      (frame) => frame.method === 'session/prompt',
    );
    assert(!!promptFrame, 'the prompt is sent');

    textChunk(session, 'half an ans');
    await until(
      () => events.some((event) => event.type === 'text_delta'),
      'the partial answer streams',
    );

    request.abort();
    const cancel = written.find((frame) => frame.method === 'session/cancel');
    assert(
      cancel?.params?.sessionId === 'acp-1',
      'an active turn signal cancels Kiro',
    );

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptFrame.id,
        result: { stopReason: 'cancelled' },
      }),
    );
    await stream;

    const failure = events.find((event) => event.type === 'error');
    assert(!!failure, 'the cancelled turn ends with a pi error event');
    assert(
      failure.reason === 'aborted',
      'the error event carries reason aborted',
    );
    assert(
      failure.error.stopReason === 'aborted',
      'the partial message is marked aborted',
    );
    assert(
      session.conversationFingerprint === null,
      'the cancelled turn clears the session fingerprint',
    );
    assert(
      persistedSaves.mock.calls.length === 0,
      'the cancelled turn is not persisted as a success',
    );
    assert(
      persistedClears.mock.calls.length === 1 &&
        persistedClears.mock.calls[0][0] === session.persistenceKey,
      'the cancelled conversation loses its resumable snapshot',
    );
    assert(
      !store.has(session.persistenceKey!),
      'no stale snapshot is left behind',
    );

    // pi drops the aborted partial; rewinding to the earlier history would let
    // the old snapshot match again, so the next request must not resume it.
    const nextContext = kiroContext('never mind');
    nextContext.messages.unshift(earlier, earlierAnswer);
    const secondEvents: string[] = [];
    const second = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        nextContext,
        opts,
      )) {
        secondEvents.push(eventSummary(event));
      }
    })();
    await until(
      () => written.some((frame) => frame.method === 'session/new'),
      'the next turn opens a fresh ACP session',
    );
    assert(
      !written.some(
        (frame) =>
          frame.method === 'session/resume' || frame.method === 'session/load',
      ),
      'the cancelled ACP session is not resumed',
    );
    answerSessionNew(
      session,
      written.find((frame) => frame.method === 'session/new'),
      'acp-2',
    );
    // V2 reapplies the model after session/new; V3 gets it from configOptions.
    await until(
      () =>
        written.some((frame) => frame.method === 'session/set_model') ||
        written.filter((frame) => frame.method === 'session/prompt').length ===
          2,
      'the next turn settles the model',
    );
    const setModel = written.find(
      (frame) => frame.method === 'session/set_model',
    );
    if (setModel) {
      session.handleStdoutLine(
        JSON.stringify({ jsonrpc: '2.0', id: setModel.id, result: {} }),
      );
    }
    await until(
      () =>
        written.filter((frame) => frame.method === 'session/prompt').length ===
        2,
      'the next turn replays the conversation',
    );
    const replay = written.filter(
      (frame) => frame.method === 'session/prompt',
    )[1];
    const replayText = replay.params.prompt[0].text;
    assert(
      replayText.includes('read notes.md') && replayText.includes('never mind'),
      'the replay carries the history the cancelled turn never finished',
    );

    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: replay.id,
        result: { stopReason: 'end_turn' },
      }),
    );
    await second;
    assert(
      secondEvents.includes('done:stop'),
      `the replay turn completes (got ${secondEvents.join(',')})`,
    );
  } finally {
    await sessionManager.stopAllSessions();
  }
});

// Either half of the check is enough on its own: Kiro's own cancel, and a
// local abort whose prompt comes back as a normal completion.
test.each([
  ['an ACP cancelled turn without a local abort', false, 'cancelled'],
  ['a locally aborted turn whose prompt ends normally', true, 'end_turn'],
])('%s also ends aborted', async (_label, withSignal, stopReason) => {
  const sessionManager = new SessionManager();

  try {
    const { session, opts, written } = await fakeTurnSession(
      sessionManager,
      'S-cancelled',
    );
    const request = new AbortController();
    const events: any[] = [];
    const stream = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        kiroContext('read notes.md'),
        { ...opts, signal: withSignal ? request.signal : undefined },
      )) {
        events.push(event);
      }
    })();
    await until(() => events.length > 0, 'the turn starts');
    const promptFrame = written.find(
      (frame) => frame.method === 'session/prompt',
    );
    assert(!!promptFrame, 'the prompt is sent');

    textChunk(session, 'half an ans');
    await until(
      () => events.some((event) => event.type === 'text_delta'),
      'the partial answer streams',
    );

    if (withSignal) request.abort();
    session.handleStdoutLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptFrame.id,
        result: { stopReason },
      }),
    );
    await stream;

    const failure = events.find((event) => event.type === 'error');
    assert(!!failure, 'the turn ends with a pi error event');
    assert(
      failure.reason === 'aborted',
      'the cancelled turn reads as aborted, not as a finished turn',
    );
    assert(
      failure.error.stopReason === 'aborted',
      'the partial message is marked aborted',
    );
    assert(
      session.conversationFingerprint === null,
      'the fingerprint is cleared',
    );
    assert(
      persistedSaves.mock.calls.length === 0,
      'nothing is persisted as a success',
    );
  } finally {
    await sessionManager.stopAllSessions();
  }
});
