// Test: a turn's request signal cannot cancel Kiro after that turn ends.
// Durable aborts each invocation's signal when its request phase ends; the
// stream must drop the listener then, or it cancels Kiro while pi runs the tool.
// Run: npm test -- test/request-signal.test.ts

process.env.PI_KIRO_ACP_TOOL_BATCH_MS = '5';

import { test } from 'vitest';

import { SessionManager } from '../src/session-manager.ts';
import { assert, kiroContext, kiroModel, wait } from './support.ts';

// Imported after the env override so the debounce is picked up.
const { streamKiroAcp } = await import('../src/stream.ts');

const CWD = '/tmp/kiro-acp-request-signal';
const model = kiroModel();

/** Wait until `condition` holds, up to a bound. */
async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await wait(5);
  }
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
  } finally {
    await sessionManager.stopAllSessions();
  }
});

test('an active turn signal cancels Kiro', async () => {
  const sessionManager = new SessionManager();

  try {
    const { session, opts, written } = await fakeTurnSession(
      sessionManager,
      'S-active',
    );
    const request = new AbortController();
    const events: string[] = [];
    const stream = (async () => {
      for await (const event of streamKiroAcp(
        sessionManager,
        model,
        kiroContext('read notes.md'),
        { ...opts, signal: request.signal },
      )) {
        events.push(
          event.type === 'done' ? `done:${(event as any).reason}` : event.type,
        );
      }
    })();
    await until(() => events.includes('start'), 'the turn starts');
    const promptFrame = written.find(
      (frame) => frame.method === 'session/prompt',
    );
    assert(!!promptFrame, 'the prompt is sent');

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
    assert(events.includes('done:stop'), 'the cancelled turn ends the stream');
  } finally {
    await sessionManager.stopAllSessions();
  }
});
