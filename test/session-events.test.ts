// Test: the kiro session metadata observer channel and the footer text.
// Run: npm test -- test/session-events.test.ts

import { expect, test } from 'vitest';

import { kiroContextStatusText } from '../src/helpers.ts';
import {
  emitKiroSessionMetadata,
  onKiroSessionMetadata,
} from '../src/session-events.ts';

test('a listener receives the emitted metadata object until it unsubscribes', () => {
  const metadata = { sessionId: 'acp-1' };
  const received: unknown[] = [];
  const off = onKiroSessionMetadata((m) => received.push(m));
  emitKiroSessionMetadata(metadata);
  expect(received[0]).toBe(metadata);
  off();
  emitKiroSessionMetadata(metadata);
  expect(received).toHaveLength(1);
});

test('a throwing listener does not stop the next one', () => {
  const received: unknown[] = [];
  const offThrowing = onKiroSessionMetadata(() => {
    throw new Error('broken observer');
  });
  const offOk = onKiroSessionMetadata((m) => received.push(m));
  expect(() => emitKiroSessionMetadata({ sessionId: 'acp-1' })).not.toThrow();
  expect(received).toHaveLength(1);
  offThrowing();
  offOk();
});

test('kiroContextStatusText formats context fill and threshold', () => {
  expect(kiroContextStatusText(null)).toBe('');
  expect(kiroContextStatusText({ sessionId: 's' })).toBe('');
  expect(
    kiroContextStatusText({
      sessionId: 's',
      contextUsagePercentage: 12.4,
      summarizationThreshold: 80,
    }),
  ).toBe('ctx 12.4% · sum@80%');
  expect(
    kiroContextStatusText({
      sessionId: 's',
      contextUsagePercentage: 83,
      summarizationThreshold: 80,
    }),
  ).toBe('ctx 83.0% · sum@80%');
  expect(
    kiroContextStatusText({ sessionId: 's', contextUsagePercentage: 5 }),
  ).toBe('ctx 5.0%');
});

test('kiroContextStatusText colours by distance to the threshold', () => {
  const colours: string[] = [];
  const theme = {
    fg: (colour: string, text: string) => {
      colours.push(colour);
      return text;
    },
  };
  for (const used of [50, 70, 80])
    kiroContextStatusText(
      {
        sessionId: 's',
        contextUsagePercentage: used,
        summarizationThreshold: 80,
      },
      theme,
    );
  expect(colours).toEqual(['muted', 'warning', 'error']);
});
