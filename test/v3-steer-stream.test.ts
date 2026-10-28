// Test: native steering through the real stream path on Kiro V3 — the steer is
// queued before the tool result is answered, the model's `[STEERING <id>: …]`
// note never reaches pi, and the recovery/image paths keep the synthetic block.
// Drives streamKiroAcp against a fake ACP process.
// Run: npm test -- test/v3-steer-stream.test.ts

// Persisted sessions must never land in the developer's data dir.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'kiro-acp-data-'));

import { test } from 'vitest';

import { SessionManager } from '../src/session-manager.ts';
import type { AcpSession } from '../src/session.ts';
import { streamKiroAcp } from '../src/stream.ts';
import { assert, kiroModel, tick, wait } from './support.ts';

const CWD = '/tmp/kiro-acp-v3-steer';
const STEER = 'STEER-TOKEN-123';

const task = { role: 'user', content: 'investigate the build' };
const toolCall = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'probe_tool', arguments: {} }],
});
const toolResult = (id: string, text: string, extra: object = {}) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'probe_tool',
  isError: false,
  content: [{ type: 'text', text }],
  ...extra,
});
const user = (content: string) => ({ role: 'user', content });
const context = (...messages: unknown[]) =>
  ({ messages, systemPrompt: '', tools: [] }) as any;

interface Harness {
  manager: SessionManager;
  session: AcpSession;
  /** What kiro receives as the answer to each of its tools/call requests. */
  answers: Map<string, any>;
  prompts: () => string[];
  steerFrames: () => any[];
  /** Model output pi streamed for the turn. */
  streamed: string[];
  /** Every pi stream event, in order (text blocks, tool calls, terminal). */
  events: any[];
  holdSteerReply: () => void;
  releaseSteerReply: () => void;
  emitText: (text: string, messageId?: string) => void;
  run: (ctx: unknown, options?: object) => Promise<void>;
}

async function v3LiveSession(
  sessionId: string,
  pendingCallIds: string[],
  opts: { steerError?: object; steerQueued?: boolean } = {},
): Promise<Harness> {
  const manager = new SessionManager();
  const opts2 = { sessionId, cwd: CWD } as any;
  const routed = await manager.routeSession(context(task), opts2);
  const session: AcpSession = routed.session;
  routed.release();
  // The stream and the session both branch on this.
  session.engine = 'v3';

  const frames: any[] = [];
  const answers = new Map<string, any>();
  const streamed: string[] = [];
  const events: any[] = [];
  let steerSeq = 0;
  let hold = false;
  const held: Array<() => void> = [];

  const reply = (id: number, payload: object) =>
    session.handleStdoutLine(
      JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
    );

  session.proc = {
    stdin: {
      writable: true,
      write(chunk: string) {
        const frame = JSON.parse(chunk);
        frames.push(frame);
        if (frame.id === undefined) return true;
        if (frame.method === '_session/steer') {
          const answer = () => {
            if (opts.steerError) reply(frame.id, { error: opts.steerError });
            else
              reply(frame.id, {
                result: {
                  queued: opts.steerQueued !== false,
                  messageId: `steer-${++steerSeq}`,
                },
              });
          };
          if (hold) held.push(answer);
          else setImmediate(answer);
          return true;
        }
        setImmediate(() =>
          reply(frame.id, {
            result:
              frame.method === 'session/prompt'
                ? { stopReason: 'end_turn' }
                : frame.method === 'session/new'
                  ? { sessionId: 'acp-2' }
                  : {},
          }),
        );
        return true;
      },
    },
  } as any;
  session.acpSessionId = 'acp-1';
  session.currentModelId = kiroModel().id;
  session.started = true;
  for (const id of pendingCallIds) {
    session.pendingToolCalls.set(id, {
      callId: id,
      toolName: 'probe_tool',
      args: {},
      receivedAt: Date.now(),
      emitted: true,
      resolve: (answer: unknown) => answers.set(id, answer),
    } as any);
  }

  return {
    manager,
    session,
    answers,
    prompts: () =>
      frames
        .filter((frame) => frame.method === 'session/prompt')
        .map((frame) => String(frame.params.prompt[0].text)),
    steerFrames: () =>
      frames.filter((frame) => frame.method === '_session/steer'),
    streamed,
    events,
    holdSteerReply: () => {
      hold = true;
    },
    releaseSteerReply: () => {
      hold = false;
      for (const answer of held.splice(0)) answer();
    },
    emitText: (text: string, messageId?: string) =>
      session.handleStdoutLine(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'acp-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              ...(messageId ? { messageId } : {}),
              content: { type: 'text', text },
            },
          },
        }),
      ),
    run: async (ctx: unknown, extra: object = {}) => {
      for await (const event of streamKiroAcp(
        manager,
        kiroModel(),
        ctx as any,
        { ...opts2, ...extra },
      )) {
        events.push(event);
        if (event.type === 'text_delta') streamed.push(event.delta);
      }
    },
  };
}

/** Text blocks pi received, as the app would show them. */
function textBlocks(events: any[]): string[] {
  const blocks: string[] = [];
  let open = -1;
  for (const event of events) {
    if (event.type === 'text_start') {
      open = blocks.length;
      blocks.push('');
    } else if (event.type === 'text_delta' && open >= 0) {
      blocks[open] += event.delta;
    } else if (event.type === 'text_end') {
      open = -1;
    }
  }
  return blocks;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('timed out waiting for condition');
}

test('a steer goes to kiro before the tool result is answered', async () => {
  const live = await v3LiveSession('S-native', ['c1']);
  live.holdSteerReply();
  try {
    const running = live.run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'build is red'),
        user(STEER),
      ),
    );
    await waitFor(() => live.steerFrames().length === 1);

    const [frame] = live.steerFrames();
    assert(
      frame.params.message === STEER && frame.params.sessionId === 'acp-1',
      `the steer text is sent verbatim (got ${JSON.stringify(frame.params)})`,
    );
    assert(
      !live.answers.has('c1'),
      'the tool result is not resolved until kiro took the steer',
    );

    live.releaseSteerReply();
    await running;

    const answer = live.answers.get('c1');
    assert(
      answer.result === 'build is red',
      'no synthetic block in the result',
    );
    assert(live.prompts().length === 0, 'no extra prompt is started');
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('two steers are queued in order and none is repeated in the result', async () => {
  const live = await v3LiveSession('S-native-two', ['c1']);
  try {
    await live.run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'ok'),
        user('STEER-A'),
        user('STEER-B'),
      ),
    );
    const sent = live.steerFrames().map((frame) => frame.params.message);
    assert(
      sent.join(',') === 'STEER-A,STEER-B',
      `both steers are queued in order (got ${JSON.stringify(sent)})`,
    );
    assert(
      live.answers.get('c1').result === 'ok',
      'the tool result stays untouched',
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('a rejected steer travels in the tool result instead', async () => {
  const live = await v3LiveSession('S-native-error', ['c1'], {
    steerError: { code: -32603, message: 'steer unavailable' },
  });
  try {
    await live.run(
      context(task, toolCall('c1'), toolResult('c1', 'ok'), user(STEER)),
    );
    const answer = live.answers.get('c1').result;
    assert(
      answer.includes('ok') && answer.includes('<user_message_during_run'),
      `the steer falls back to the synthetic block (got ${JSON.stringify(answer)})`,
    );
    assert(answer.includes(STEER), 'the steer text is in the block');
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('the recovery prompt keeps the synthetic block on v3', async () => {
  // No pending call: kiro dropped its tools/call, so the result is handed back
  // as a new prompt — there is no tool result left to steer into.
  const live = await v3LiveSession('S-native-recovery', []);
  try {
    await live.run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'late report'),
        user('STEER-A'),
      ),
    );
    const sent = live.prompts();
    assert(sent.length === 1, 'the recovery prompt is sent');
    assert(
      sent[0].includes('late report') && sent[0].includes('STEER-A'),
      'the result and the steer both reach the model',
    );
    assert(
      live.steerFrames().length === 0,
      'no native steer outside the tool-result path',
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('the image follow-up keeps the synthetic block on v3', async () => {
  const live = await v3LiveSession('S-native-image', ['c1']);
  live.session.activePromptDone = Promise.resolve({ stopReason: 'cancelled' });
  try {
    await live.run(
      context(
        task,
        toolCall('c1'),
        toolResult('c1', 'screenshot taken', {
          content: [
            { type: 'text', text: 'screenshot taken' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        }),
        user(STEER),
      ),
    );
    assert(
      live.answers.get('c1').result.includes('screenshot taken'),
      'the tool result still reaches kiro',
    );
    const sent = live.prompts().join('\n');
    assert(
      sent.includes(STEER) && sent.includes('investigate the build'),
      'the steer rides in the follow-up prompt',
    );
    assert(
      live.steerFrames().length === 0,
      'no native steer on the image path',
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('the model’s steer note never reaches pi', async () => {
  const live = await v3LiveSession('S-native-echo', ['c1']);
  // Kiro keeps streaming into the live turn after the tool result; the prompt
  // settles only when the turn is over.
  let finishTurn: () => void = () => {};
  live.session.activePromptDone = new Promise((resolve) => {
    finishTurn = () => resolve({ stopReason: 'end_turn' } as any);
  });
  try {
    const running = live.run(
      context(task, toolCall('c1'), toolResult('c1', 'ok'), user(STEER)),
    );
    await waitFor(() => live.session.steerMessageIds.size === 1);
    const [messageId] = [...live.session.steerMessageIds];
    // Cut inside the id: a partial id must not be read as a complete, unknown
    // one, or the note is released to pi.
    live.emitText('Here is the answer.\n\n[STEERING steer-');
    live.emitText(`${messageId.slice('steer-'.length)}: CANARY]`);
    await tick();
    finishTurn();
    await running;

    const text = live.streamed.join('');
    assert(
      text === 'Here is the answer.',
      `only the answer is streamed (got ${JSON.stringify(text)})`,
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('held whitespace stays in the block it belongs to', async () => {
  const live = await v3LiveSession('S-native-block-split', ['c1']);
  // The filter only holds text while a native steer id exists.
  live.session.steerMessageIds.add('steer-1');
  let finishTurn: () => void = () => {};
  live.session.activePromptDone = new Promise((resolve) => {
    finishTurn = () => resolve({ stopReason: 'end_turn' } as any);
  });
  try {
    const running = live.run(
      context(task, toolCall('c1'), toolResult('c1', 'ok')),
    );
    await tick();
    live.emitText('Hello ', 'm1');
    live.emitText('world', 'm2');
    await tick();
    finishTurn();
    await running;

    const blocks = textBlocks(live.events);
    assert(
      blocks.join('|') === 'Hello |world',
      `the held space ends the first block (got ${JSON.stringify(blocks)})`,
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('an aborted turn queues no native steer', async () => {
  const live = await v3LiveSession('S-native-aborted', ['c1']);
  try {
    await live.run(
      context(task, toolCall('c1'), toolResult('c1', 'ok'), user(STEER)),
      {
        signal: {
          aborted: true,
          addEventListener() {},
          removeEventListener() {},
        },
      },
    );
    assert(
      live.steerFrames().length === 0,
      `a cancelled turn sends no _session/steer (got ${JSON.stringify(live.steerFrames())})`,
    );
    const answer = live.answers.get('c1')?.result ?? '';
    assert(
      answer.includes('<user_message_during_run') && answer.includes(STEER),
      `the steer travels in the tool result instead (got ${JSON.stringify(answer)})`,
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});

test('a steer kiro queued is not repeated by a recovery prompt', async () => {
  const live = await v3LiveSession('S-native-retry', ['c1']);
  try {
    // The steered turn declares the steer to kiro, then dies: pi retries the
    // same request, whose tool result is orphaned — the recovery prompt must
    // not hand the model the steer a second time.
    await live.run(
      context(task, toolCall('c1'), toolResult('c1', 'ok'), user(STEER)),
    );
    assert(
      live.steerFrames().length === 1 &&
        live.session.nativeSteerTexts.includes(STEER),
      'the steer was queued natively first',
    );

    await live.run(
      context(
        task,
        toolCall('c2'),
        toolResult('c2', 'late report'),
        user(STEER),
      ),
    );
    const sent = live.prompts().join('\n');
    assert(
      sent.includes('late report'),
      'the recovery prompt still carries the tool result',
    );
    assert(
      !sent.includes(STEER) && !sent.includes('<message role="user">'),
      `the already-queued steer is not sent again (got ${JSON.stringify(sent)})`,
    );
  } finally {
    await live.manager.stopAllSessions();
  }
});
