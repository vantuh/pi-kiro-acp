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

// The note a live V3 run actually produced (steer.mjs, 2025-…): a real answer,
// a blank line, then the model's acknowledgement of the steer.
const REAL_ID = 'steer-44bd8388-370c-45b5-b155-82c8ffb30326';
const REAL_ANSWER =
  'The slow tool ran successfully and returned status OK — CANARY-595DD3.';
const REAL_NOTE =
  REAL_ANSWER +
  `\n\n[STEERING ${REAL_ID}: Incorporated the code word CANARY-595DD3 into the final one-sentence answer.]`;

/** Feed `text` cut at every listed offset and return what pi would have seen. */
function feed(text: string, cuts: number[], steerIds: string[]): string {
  const filter = createSteerEchoFilter(ids(...steerIds));
  let out = '';
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out += filter.push(text.slice(at, cut));
    at = cut;
  }
  return out + filter.flush();
}

/** A chunk boundary every `size` characters. */
function evenCuts(text: string, size: number): number[] {
  const cuts: number[] = [];
  for (let i = size; i < text.length; i += size) cuts.push(i);
  return cuts;
}

test('the real note is stripped at every chunk size', () => {
  for (let size = 1; size <= REAL_NOTE.length; size++) {
    const out = feed(REAL_NOTE, evenCuts(REAL_NOTE, size), [REAL_ID]);
    assert(
      out === REAL_ANSWER,
      `chunk size ${size}: only the answer survives (got ${JSON.stringify(out)})`,
    );
  }
});

test('a foreign id is preserved byte for byte at every chunk size', () => {
  for (let size = 1; size <= REAL_NOTE.length; size++) {
    const out = feed(REAL_NOTE, evenCuts(REAL_NOTE, size), ['steer-other']);
    assert(
      out === REAL_NOTE,
      `chunk size ${size}: a note that is not ours is untouched (got ${JSON.stringify(out)})`,
    );
  }
});

test('random chunk boundaries strip the note and keep everything else', () => {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let run = 0; run < 200; run++) {
    const cuts: number[] = [];
    for (let i = 1; i < REAL_NOTE.length; i++) if (next() < 0.15) cuts.push(i);
    const out = feed(REAL_NOTE, cuts, [REAL_ID]);
    assert(
      out === REAL_ANSWER,
      `cut ${JSON.stringify(cuts)}: only the answer survives (got ${JSON.stringify(out)})`,
    );
    const kept = feed(REAL_NOTE, cuts, ['steer-other']);
    assert(
      kept === REAL_NOTE,
      `cut ${JSON.stringify(cuts)}: a foreign note is untouched (got ${JSON.stringify(kept)})`,
    );
  }
});

test('the note is stripped wherever it sits, at every chunk size', () => {
  const variants = [
    {
      name: 'at the start',
      text: `[STEERING ${REAL_ID}: x] tail`,
      expected: ' tail',
    },
    {
      name: 'mid-text followed by text',
      text: `A [STEERING ${REAL_ID}: x] B`,
      expected: 'A B',
    },
    {
      name: 'with nested brackets',
      text: `A\n\n[STEERING ${REAL_ID}: Added [x] to answer.] B`,
      expected: 'A B',
    },
    {
      // The id runs straight into the closing bracket.
      name: 'without a body',
      text: `A [STEERING ${REAL_ID}] B`,
      expected: 'A B',
    },
  ];
  for (const { name, text, expected } of variants) {
    for (let size = 1; size <= text.length; size++) {
      const out = feed(text, evenCuts(text, size), [REAL_ID]);
      assert(
        out === expected,
        `${name}, chunk size ${size}: got ${JSON.stringify(out)}`,
      );
      const kept = feed(text, evenCuts(text, size), ['steer-other']);
      assert(
        kept === text,
        `${name}, chunk size ${size}: a foreign id is untouched (got ${JSON.stringify(kept)})`,
      );
    }
  }
});
