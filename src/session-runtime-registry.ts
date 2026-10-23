import type { SessionManager } from './session-manager.ts';

export interface KiroSessionRuntime {
  sessionManager: SessionManager;
}

/** Shared by every extension instance: native provider registration is global,
 * so a request for a session id must find the runtime that owns that session. */
export class KiroSessionRuntimeRegistry {
  readonly #runtimes = new Map<string, KiroSessionRuntime>();

  register(sessionId: string, runtime: KiroSessionRuntime): void {
    this.#runtimes.set(sessionId, runtime);
  }

  unregister(sessionId: string, runtime: KiroSessionRuntime): void {
    if (this.#runtimes.get(sessionId) === runtime) {
      this.#runtimes.delete(sessionId);
    }
  }

  resolve(sessionId?: string): KiroSessionRuntime {
    if (sessionId) {
      const runtime = this.#runtimes.get(sessionId);
      if (runtime) return runtime;
      throw new Error(
        `No kiro-acp runtime registered for session ${sessionId}`,
      );
    }

    if (this.#runtimes.size === 1) {
      const runtime = this.#runtimes.values().next().value;
      if (runtime) return runtime;
    }

    throw new Error(
      `Cannot resolve kiro-acp runtime without a session id (${this.#runtimes.size} registered)`,
    );
  }
}

export const sessionRuntimeRegistry = new KiroSessionRuntimeRegistry();
