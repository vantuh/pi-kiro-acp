// Test: streamKiroAcp handles AbortSignal without hanging.
// Run: npm test -- test/abort.test.ts

import { test } from 'vitest';

import { SessionManager } from '../src/session-manager.ts';
import { streamKiroAcp } from '../src/stream.ts';
import { assert, kiroContext, kiroModel } from './support.ts';

const sessionManager = new SessionManager();

test('streamKiroAcp ends the stream after an abort', async () => {
  const model = kiroModel();

  const context = kiroContext(
    'Count from 1 to 100 slowly, one number per word. Do not stop early.',
  );

  try {
    const ac = new AbortController();
    const stream = streamKiroAcp(sessionManager, model, context, {
      signal: ac.signal,
    });
    const eventTypes: string[] = [];
    let gotDelta = false;
    let streamEnded = false;

    const consume = (async () => {
      for await (const event of stream) {
        eventTypes.push(event.type);
        if (
          (event.type === 'text_delta' || event.type === 'thinking_delta') &&
          !gotDelta
        ) {
          gotDelta = true;
          ac.abort();
        }
      }
      streamEnded = true;
    })();

    // Fallback abort if no delta arrives quickly
    const fallback = setTimeout(() => ac.abort(), 5000);

    await Promise.race([
      consume,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error('stream hung after abort')),
          30000,
        ).unref(),
      ),
    ]);
    clearTimeout(fallback);

    console.log('Events received:', eventTypes);
    assert(streamEnded, 'expected stream to end after abort');
    console.log('✓ stream ended without hanging');
    console.log('✓ abort test passed');
  } finally {
    await sessionManager.stopAllSessions();
  }
});
