import type { SessionMetadata } from './types.ts';

type Listener = (metadata: SessionMetadata) => void;

/** Module-level, like the session runtime registry: every extension instance
 * and session in the process shares it. */
const listeners = new Set<Listener>();

export function onKiroSessionMetadata(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitKiroSessionMetadata(metadata: SessionMetadata): void {
  for (const listener of [...listeners]) {
    try {
      listener(metadata);
    } catch {
      // A broken observer must not break the session.
    }
  }
}
