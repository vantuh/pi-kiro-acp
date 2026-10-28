// Test: the V3 steer echo filter — the model repeats a native steer back as a
// `[STEERING <id>: …]` note, which pi must never show. Pure unit tests over the
// streaming filter; no kiro-cli and no session.
// Run: npm test -- test/v3-steer-echo.test.ts

import { test } from 'vitest';

import { createSteerEchoFilter } from '../src/v3/steer-echo.ts';
import { assert } from './support.ts';

const ids = (...values: string[]) => {
  const set = new Set(values);
  return () => set;
};

/** Feed chunks in order and report what pi would have seen. */
function run(
  filter: ReturnType<typeof createSteerEchoFilter>,
  chunks: string[],
): string[] {
  const emitted = chunks.map((chunk) => filter.push(chunk));
  emitted.push(filter.flush());
  return emitted;
}

test('a whole echo block in one chunk is dropped with its blank lines', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const [only] = run(filter, ['The answer.\n\n[STEERING steer-abc: CANARY]']);
  assert(
    only === 'The answer.',
    `the note and the blank lines before it are gone (got ${JSON.stringify(only)})`,
  );
});

test('an echo block split across many chunks is still dropped', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const chunks = [
    'The answer.',
    '\n\n[ST',
    'EER',
    'ING steer-abc: CAN',
    'ARY',
    ']',
  ];
  const emitted = run(filter, chunks);
  assert(
    emitted.join('') === 'The answer.',
    `nothing of the split note survives (got ${JSON.stringify(emitted.join(''))})`,
  );
});

test('a note for another steer is kept', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const text = 'The answer.\n\n[STEERING steer-other: CANARY]';
  const [only] = run(filter, [text]);
  assert(
    only === text,
    `an unknown id is model output, not our note (got ${JSON.stringify(only)})`,
  );
});

test('brackets that are not a steering note pass through', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const [single] = run(createSteerEchoFilter(ids('steer-abc')), [
    'use [1] and [ok] twice',
  ]);
  assert(
    single === 'use [1] and [ok] twice',
    `ordinary brackets are untouched (got ${JSON.stringify(single)})`,
  );

  // A `[` on its own is undecided for one chunk, then released.
  const [first, second] = run(filter, ['cost [', '5] total']);
  assert(
    first === 'cost' && second === ' [5] total',
    `the undecided bracket waits for the next chunk (got ${JSON.stringify([first, second])})`,
  );
});

test('text after the note is preserved', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const [only] = run(filter, ['[STEERING steer-abc: CANARY] tail']);
  assert(
    only.includes('tail') &&
      !only.includes('STEERING') &&
      !only.includes('CANARY'),
    `only the note is removed (got ${JSON.stringify(only)})`,
  );
});

test('held text is flushed when the block ends', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const visible = filter.push('answer [STEERING ');
  const rest = filter.flush();
  assert(
    visible === 'answer' && rest === ' [STEERING ',
    `an unfinished block is released at the end, not lost (got ${JSON.stringify([visible, rest])})`,
  );
});

test('the filter is a no-op when no steer was queued', () => {
  const filter = createSteerEchoFilter(ids());
  const emitted = run(filter, ['a [', 'b] ', '[STEERING steer-x: hi]']);
  assert(
    emitted.join('') === 'a [b] [STEERING steer-x: hi]',
    `nothing is held or dropped without a recorded steer (got ${JSON.stringify(emitted.join(''))})`,
  );
  assert(emitted[0] === 'a [', 'the first chunk is emitted at once');
});

test('ids recorded mid-turn are honoured', () => {
  const set = new Set<string>();
  const filter = createSteerEchoFilter(() => set);
  const early = filter.push('start ');
  set.add('steer-late');
  const rest = filter.push('[STEERING steer-late: CANARY]');
  const tail = filter.flush();
  assert(
    early === 'start ' && rest.trim() === '' && tail === '',
    `a steer queued after the first chunk still gets its note stripped (got ${JSON.stringify([early, rest, tail])})`,
  );
});

test('a bracket inside the note does not end it', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const [only] = run(filter, [
    'Answer.\n\n[STEERING steer-abc: Added [x] to answer.]',
  ]);
  assert(
    only === 'Answer.',
    `the whole nested note is stripped (got ${JSON.stringify(only)})`,
  );
});

test('an open note with another id is released at once', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const [first, second] = run(filter, [
    'Answer. [STEERING steer-other: not ',
    'ours] tail',
  ]);
  // Only the trailing space is still held: it may introduce the next note.
  assert(
    first === 'Answer. [STEERING steer-other: not',
    `a note that is not ours is not held (got ${JSON.stringify(first)})`,
  );
  assert(
    first + second === 'Answer. [STEERING steer-other: not ours] tail',
    'the rest follows unchanged',
  );
});

test('a note that never closes is released once the hold cap is reached', () => {
  const filter = createSteerEchoFilter(ids('steer-abc'));
  const head = 'Answer. [STEERING steer-abc: ';
  const first = filter.push(head);
  assert(
    first === 'Answer.',
    `the note is held at first (got ${JSON.stringify(first)})`,
  );
  const rest = filter.push('x'.repeat(1200));
  assert(
    rest === head.slice('Answer.'.length) + 'x'.repeat(1200),
    `an unterminated note is released, not held forever (got ${JSON.stringify(rest.slice(0, 40))}…)`,
  );
  assert(filter.flush() === '', 'nothing is left held after the cap');
});
