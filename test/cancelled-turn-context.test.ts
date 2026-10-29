// Test: the prompt text built after a cancelled answer carries a cancellation
// note, so a warm follow-up does not read as an unfinished task.
// Run: npm test -- test/cancelled-turn-context.test.ts

import type {
  AssistantMessage,
  Context,
  Message,
  StopReason,
  SystemMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { test } from 'vitest';

import { buildPromptParts } from '../src/helpers.ts';
import { assert } from './support.ts';

const CANCELLED_TURN_NOTE =
  'The previous assistant response was interrupted by cancellation. Treat it as incomplete history, not a task to finish automatically. Follow the current user request; continue the earlier task only if the user now asks for it. Earlier context and preferences still apply.';

const userMessage = (content: UserMessage['content']): UserMessage => ({
  role: 'user',
  content,
  timestamp: 1,
});

const assistantMessage = (
  text: string,
  stopReason: StopReason,
): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'kiro-acp-api',
  provider: 'kiro-acp',
  model: 'claude-sonnet-4.6',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

const systemMessage = (content: string): SystemMessage => ({
  role: 'system',
  content,
  timestamp: 3,
});

/** What pi hands the provider: a real TranscriptContext. */
const promptParts = (messages: Message[], includeHistory: boolean) =>
  buildPromptParts(
    normalizeContext({ messages } satisfies Context),
    includeHistory,
  );

test('a warm turn after a cancelled answer names the cancellation', () => {
  const context = {
    messages: [
      userMessage('Name both methods'),
      assistantMessage(
        'The first method is rather long and unfinished',
        'aborted',
      ),
      userMessage('Name both - no code.'),
    ],
  } satisfies Context;
  const before = JSON.stringify(context);

  const parts = buildPromptParts(normalizeContext(context), false);

  assert(
    parts.userMessage === `${CANCELLED_TURN_NOTE}\n\nName both - no code.`,
    `the current request follows the cancellation note (got "${parts.userMessage}")`,
  );
  assert(
    !parts.userMessage.includes('<conversation_history>'),
    'a warm turn still replays no history',
  );
  assert(
    !parts.userMessage.includes('The first method is rather long'),
    'the cancelled partial is not replayed',
  );
  assert(JSON.stringify(context) === before, 'the context is not mutated');
});

test('a replay after a cancelled answer keeps history escaping', () => {
  const parts = promptParts(
    [
      userMessage('a & b <tag>'),
      assistantMessage('partial answer', 'aborted'),
      userMessage('c & d <tag>'),
    ],
    true,
  );

  assert(
    parts.userMessage.startsWith(`${CANCELLED_TURN_NOTE}\n\n`),
    'the replay prompt opens with the cancellation note',
  );
  assert(
    parts.userMessage.includes('a &amp; b &lt;tag&gt;'),
    'the earlier user turn stays escaped exactly once',
  );
  assert(
    parts.userMessage.includes(
      '<current_user_message>\nc &amp; d &lt;tag&gt;\n</current_user_message>',
    ),
    'the current user message keeps its escaped block',
  );
});

test('a normal follow-up is byte-exact', () => {
  const parts = promptParts(
    [
      userMessage('Name both methods'),
      assistantMessage('Both are named.', 'stop'),
      userMessage('and then?'),
    ],
    false,
  );

  assert(
    parts.userMessage === 'and then?',
    'a completed previous answer adds nothing to the next prompt',
  );
});

test('an older cancelled answer does not outlive a completed turn', () => {
  const parts = promptParts(
    [
      userMessage('first task'),
      assistantMessage('cancelled partial', 'aborted'),
      userMessage('second task'),
      assistantMessage('second task done', 'stop'),
      userMessage('third task'),
    ],
    false,
  );

  assert(
    parts.userMessage === 'third task',
    'only the immediately preceding turn is marked cancelled',
  );
});

test('a system delta between turns does not hide the cancellation', () => {
  const messages = [
    userMessage('first task'),
    assistantMessage('cancelled partial', 'aborted'),
    systemMessage('Tool declarations updated.'),
    userMessage('and then?'),
  ];

  assert(
    promptParts(messages, false).userMessage ===
      `${CANCELLED_TURN_NOTE}\n\nand then?`,
    'the warm prompt carries the note across the system delta',
  );
  assert(
    promptParts(messages, true).userMessage.startsWith(
      `${CANCELLED_TURN_NOTE}\n\n`,
    ),
    'the replay prompt carries the note across the system delta',
  );
});

test('a user message between the cancel and the request means no note', () => {
  const parts = promptParts(
    [
      userMessage('first task'),
      assistantMessage('cancelled partial', 'aborted'),
      userMessage('a steer'),
      userMessage('and then?'),
    ],
    false,
  );

  assert(
    parts.userMessage === 'and then?',
    'the scan stops at the first non-system message instead of back-searching',
  );
});

test('an explicit continuation keeps the request as typed', () => {
  const parts = promptParts(
    [
      userMessage('first task'),
      assistantMessage('cancelled partial', 'aborted'),
      userMessage('Continue the earlier task: finish both methods.'),
    ],
    false,
  );

  assert(
    parts.userMessage ===
      `${CANCELLED_TURN_NOTE}\n\nContinue the earlier task: finish both methods.`,
    'the note leaves the resume request itself untouched',
  );
});

test('a warm turn after a cancelled answer carries only the current image', () => {
  const parts = promptParts(
    [
      userMessage([
        { type: 'text', text: 'first task' },
        { type: 'image', data: 'OLD', mimeType: 'image/png' },
      ]),
      assistantMessage('cancelled partial', 'aborted'),
      userMessage([
        { type: 'text', text: 'and this image?' },
        { type: 'image', data: 'NOW', mimeType: 'image/png' },
      ]),
    ],
    false,
  );

  assert(
    parts.userMessage === `${CANCELLED_TURN_NOTE}\n\nand this image?`,
    'the note wraps the current request text only',
  );
  assert(
    parts.images.length === 1 && parts.images[0].data === 'NOW',
    'the earlier image is not replayed alongside it',
  );
});
