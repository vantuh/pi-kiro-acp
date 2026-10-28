// Test: native steering on Kiro V3 — a steer is queued with `_session/steer`
// before the tool result is answered, and falls back to the synthetic block
// inside that result when kiro will not take it. Driven by a fake session.
// Run: npm test -- test/v3-steer.test.ts

// Persisted sessions must never land in the developer's data dir.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'kiro-acp-data-'));

import { test } from 'vitest';

import type { AcpSession } from '../src/session.ts';
import type { ToolResultInfo } from '../src/types.ts';
import { assert, fakeSession, settled, tick } from './support.ts';

const STEER_BLOCK_OPEN = '<user_message_during_run';

function v3Session(): { session: AcpSession; written: any[] } {
  const fake = fakeSession({
    started: true,
    acpSessionId: 'acp-1',
    parseJson: true,
  });
  fake.session.engine = 'v3';
  return fake;
}

/** One pending bridge call, so the result has somewhere to land. */
function pendingCall(
  session: AcpSession,
  callId: string,
): Map<string, { result: string; isError?: boolean }> {
  const answers = new Map<string, { result: string; isError?: boolean }>();
  session.pendingToolCalls.set(callId, {
    callId,
    toolName: 'probe_tool',
    args: {},
    receivedAt: Date.now(),
    emitted: true,
    resolve: (answer: any) => answers.set(callId, answer),
  } as any);
  return answers;
}

const toolResult = (callId: string, text: string): ToolResultInfo => ({
  toolCallId: callId,
  toolName: 'probe_tool',
  text,
  isError: false,
  content: [{ type: 'text', text }],
});

const steerFrames = (written: any[]) =>
  written.filter((frame) => frame.method === '_session/steer');

const answerSteer = (
  session: AcpSession,
  frame: any,
  result: unknown,
): void => {
  session.handleStdoutLine(
    JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }),
  );
};

test('a steer is queued before the tool result is answered', async () => {
  const { session, written } = v3Session();
  const answers = pendingCall(session, 'c1');

  const delivering = session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
  });
  await tick();

  const [frame] = steerFrames(written);
  assert(
    frame?.params?.message === 'STEER-A' &&
      frame?.params?.sessionId === 'acp-1',
    `the steer is sent as _session/steer for this session (got ${JSON.stringify(frame?.params)})`,
  );
  assert(
    !answers.has('c1'),
    'the tool result waits for kiro to answer the steer',
  );

  answerSteer(session, frame, { queued: true, messageId: 'steer-1' });
  await delivering;

  const answer = answers.get('c1')!;
  assert(
    answer.result === 'done',
    'the tool result carries no synthetic block',
  );
  assert(
    session.steerMessageIds.has('steer-1'),
    'the queued id is recorded for the echo filter',
  );
});

test('two steers are queued in order', async () => {
  const { session, written } = v3Session();
  pendingCall(session, 'c1');

  const delivering = session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A', 'STEER-B'],
  });
  await tick();
  answerSteer(session, steerFrames(written)[0], {
    queued: true,
    messageId: 'steer-1',
  });
  await tick();
  answerSteer(session, steerFrames(written)[1], {
    queued: true,
    messageId: 'steer-2',
  });
  await delivering;

  assert(
    steerFrames(written)
      .map((frame) => frame.params.message)
      .join(',') === 'STEER-A,STEER-B',
    `both steers arrive in order (got ${JSON.stringify(steerFrames(written).map((frame) => frame.params.message))})`,
  );
  assert(session.steerMessageIds.size === 2, 'both ids are recorded');
});

test('a failed steer falls back to the synthetic block', async () => {
  const { session, written } = v3Session();
  const answers = pendingCall(session, 'c1');

  const delivering = session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
  });
  await tick();
  session.handleStdoutLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: steerFrames(written)[0].id,
      error: { code: -32603, message: 'steer rejected' },
    }),
  );
  await delivering;

  const text = answers.get('c1')!.result;
  assert(
    text.startsWith('done') && text.includes(STEER_BLOCK_OPEN),
    `the steer travels in the tool result instead (got ${JSON.stringify(text)})`,
  );
  assert(text.includes('STEER-A'), 'the steer text is in the block');
  assert(session.steerMessageIds.size === 0, 'a failed steer records no id');

  // Kiro refused once: steer natively again would risk a double delivery.
  const secondAnswers = pendingCall(session, 'c2');
  await session.deliverToolResults([toolResult('c2', 'second')], {
    steers: ['STEER-B'],
  });
  assert(
    steerFrames(written).length === 1,
    'no second _session/steer is attempted',
  );
  assert(
    secondAnswers.get('c2')!.result.includes('STEER-B') &&
      secondAnswers.get('c2')!.result.includes(STEER_BLOCK_OPEN),
    'the steer goes into the tool result',
  );
});

test('a steer kiro did not queue falls back to the block', async () => {
  const { session, written } = v3Session();
  const answers = pendingCall(session, 'c1');

  const delivering = session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
  });
  await tick();
  // An id without `queued: true` is still a refusal.
  answerSteer(session, steerFrames(written)[0], {
    queued: false,
    messageId: 'steer-9',
  });
  await delivering;

  assert(
    answers.get('c1')!.result.includes(STEER_BLOCK_OPEN),
    'a steer that was not queued goes into the tool result',
  );
  assert(
    session.steerMessageIds.size === 0,
    'an unqueued steer records no id, so its note is not stripped',
  );
});

test('a tool result with no steer is unchanged', async () => {
  const { session, written } = v3Session();
  const answers = pendingCall(session, 'c1');

  await session.deliverToolResults([toolResult('c1', 'plain')]);

  assert(answers.get('c1')!.result === 'plain', 'the result is untouched');
  assert(written.length === 0, 'no RPC is sent without a steer');
});

test('a steer with no live tool result sends no RPC', async () => {
  const { session, written } = v3Session();

  const outcome = await settled(
    session.deliverToolResults([toolResult('c9', 'late')], {
      steers: ['STEER-A'],
    }),
  );

  assert(outcome.ok, 'delivery still completes');
  assert(written.length === 0, 'there is nothing for kiro to steer into');
});

test('v2 never sends a native steer', async () => {
  const fake = fakeSession({
    started: true,
    acpSessionId: 'acp-1',
    parseJson: true,
  });
  const answers = pendingCall(fake.session, 'c1');

  await fake.session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
  });

  assert(fake.written.length === 0, 'no _session/steer on v2');
  assert(
    answers.get('c1')!.result.includes(STEER_BLOCK_OPEN),
    'the steer keeps the synthetic block on v2',
  );
});

test('native steering can be turned off for a cancelled turn', async () => {
  const { session, written } = v3Session();
  const answers = pendingCall(session, 'c1');

  await session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
    nativeSteer: false,
  });

  assert(
    steerFrames(written).length === 0,
    `a cancelled turn queues nothing (got ${JSON.stringify(written)})`,
  );
  assert(
    answers.get('c1')!.result.includes(STEER_BLOCK_OPEN),
    'the steer still travels in the tool result',
  );
});

test('steers kiro already queued are dropped from a synthetic block', async () => {
  const { session, written } = v3Session();
  pendingCall(session, 'c1');

  const delivering = session.deliverToolResults([toolResult('c1', 'done')], {
    steers: ['STEER-A'],
  });
  await tick();
  answerSteer(session, steerFrames(written)[0], {
    queued: true,
    messageId: 'steer-1',
  });
  await delivering;

  assert(
    session.steersNotQueuedNatively(['STEER-A']).length === 0,
    'the queued steer is not handed over again',
  );
  assert(
    session.steersNotQueuedNatively(['STEER-A', 'STEER-B']).join(',') ===
      'STEER-B',
    'a steer kiro never saw is kept',
  );
});
