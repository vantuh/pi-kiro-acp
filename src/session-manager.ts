import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai';

import { extractToolResults } from './helpers.ts';
import { log } from './logging.ts';
import { persistenceKeyForSession } from './session-persistence.ts';
import { AcpSession, type KiroEffort } from './session.ts';
import { hostToolCatalog } from './tool-catalog.ts';
import type { ToolResultInfo } from './types.ts';

export interface RoutedSession {
  session: AcpSession;
  toolResults: ToolResultInfo[];
  /**
   * Why the context was routed the way it was:
   * - "prompt": a plain turn — no tool results, or results placed on a fresh
   *   or idle session.
   * - "resumption": a pending bridge call matched the context's tool results.
   * - "orphaned": tool results matched no pending call — Kiro abandoned its
   *   own tools/call before pi finished running the tool. The result can no
   *   longer be answered into that MCP request, so it has to be handed back
   *   as a follow-up prompt instead.
   */
  kind: 'prompt' | 'resumption' | 'orphaned';
}

export type KiroStreamOptions = SimpleStreamOptions & {
  cwd?: string;
};

/** Sessions that still hold a live Kiro conversation, most recently used first. */
function liveSessionsForKey(
  sessions: Map<string, AcpSession>,
  keyPrefix: string,
  cwd: string,
): AcpSession[] {
  return [...sessions.entries()]
    .filter(([key]) => key === keyPrefix || key.startsWith(`${keyPrefix}:`))
    .map(([, session]) => session)
    .filter(
      (session) =>
        session.started && !!session.acpSessionId && session.cwd === cwd,
    )
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

async function routeSession(
  sessions: Map<string, AcpSession>,
  context: Context,
  options?: KiroStreamOptions,
): Promise<RoutedSession> {
  const toolResults = extractToolResults(context);
  const sessionId =
    typeof options?.sessionId === 'string' && options.sessionId
      ? options.sessionId
      : undefined;
  const requestedCwd = options?.cwd ?? process.cwd();
  let kind: RoutedSession['kind'] = 'prompt';

  if (toolResults.length > 0) {
    const matches = [...sessions.values()]
      .map((session) => ({
        session,
        matches: session.matchingToolResults(toolResults).length,
      }))
      .filter((x) => x.matches > 0)
      .sort((a, b) => b.matches - a.matches);

    if (matches[0]) {
      log('route resumption', {
        session: matches[0].session.id,
        matches: matches[0].matches,
        toolResults: toolResults.length,
      });
      return {
        session: matches[0].session,
        toolResults,
        kind: 'resumption',
      };
    }

    // No pending call to answer. Never fall through to "fresh session + replay"
    // here: a brand-new Kiro session would redo the work the tool just did.
    // Reuse the live session that still remembers the conversation and let the
    // stream deliver the result as a follow-up prompt instead.
    kind = 'orphaned';
    log('route: no resumption match found', {
      toolResults: toolResults.length,
      toolNames: toolResults.map((t) => t.toolName),
      pendingSessions: [...sessions.entries()].map(([k, s]) => ({
        key: k,
        pending: s.pendingToolCalls.size,
        busy: s.busy,
        started: s.started,
      })),
    });

    const reusable = sessionId
      ? liveSessionsForKey(sessions, `pi:${sessionId}`, requestedCwd)[0]
      : undefined;
    if (reusable) {
      if (sessionId)
        reusable.persistenceKey = persistenceKeyForSession(
          sessionId,
          requestedCwd,
        );
      log('route orphaned tool result to live session', {
        session: reusable.id,
        acpSessionId: reusable.acpSessionId,
        toolNames: toolResults.map((t) => t.toolName),
      });
      return {
        session: reusable,
        toolResults,
        kind,
      };
    }
    log('route orphaned tool result: no live session to recover into', {
      sessionId,
      cwd: requestedCwd,
    });
  }

  const key = sessionId ? `pi:${sessionId}` : undefined;

  if (key) {
    const persistenceKey = persistenceKeyForSession(sessionId!, requestedCwd);
    let existing = sessions.get(key);
    if (existing && !existing.busy && existing.cwd !== requestedCwd) {
      sessions.delete(key);
      await existing.stop();
      existing = undefined;
    }
    if (existing && !existing.busy) {
      existing.persistenceKey = persistenceKey;
      log('route existing keyed session', {
        session: existing.id,
        key,
        cwd: requestedCwd,
        busy: existing.busy,
        persistenceKey,
      });
      return {
        session: existing,
        toolResults,
        kind,
      };
    }

    const created = new AcpSession(requestedCwd);
    const actualKey = existing?.busy ? `${key}:parallel:${created.id}` : key;
    created.persistenceKey = actualKey === key ? persistenceKey : null;
    sessions.set(actualKey, created);
    log('route new keyed session', {
      session: created.id,
      key: actualKey,
      originalKey: key,
      cwd: requestedCwd,
      existingBusy: !!existing?.busy,
      persistenceKey: created.persistenceKey,
    });
    return {
      session: created,
      toolResults,
      kind,
    };
  }

  // No session id: an anonymous request must never inherit another independent
  // conversation that happens to be idle in the same cwd.
  const created = new AcpSession(requestedCwd);
  created.persistenceKey = null;
  sessions.set(`anon:${created.id}`, created);
  log('route new anon session', {
    session: created.id,
    cwd: requestedCwd,
    activeSessions: sessions.size,
  });
  return {
    session: created,
    toolResults,
    kind,
  };
}

async function stopAllSessions(
  sessions: Map<string, AcpSession>,
): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(all.map((session) => session.stop()));
}

export class SessionManager {
  readonly #sessions = new Map<string, AcpSession>();
  readonly #pendingRoutes = new Set<Promise<unknown>>();
  readonly #pendingStartups = new Set<Promise<unknown>>();
  readonly #pendingTeardowns = new Set<Promise<unknown>>();
  #closed = false;
  #stopping = false;
  #closePromise: Promise<void> | null = null;

  routeSession(
    context: Context,
    options?: KiroStreamOptions,
  ): Promise<RoutedSession> {
    if (this.#closed)
      return Promise.reject(new Error('Kiro ACP runtime is closed'));
    if (this.#stopping)
      return Promise.reject(new Error('Kiro ACP runtime is stopping'));
    const pending = routeSession(this.#sessions, context, options);
    this.#pendingRoutes.add(pending);
    void pending.then(
      () => this.#pendingRoutes.delete(pending),
      () => this.#pendingRoutes.delete(pending),
    );
    return pending;
  }

  /** Start one session and keep the startup visible to stop/close. */
  async startSession(
    session: AcpSession,
    catalogProvider: () => ReturnType<typeof hostToolCatalog>,
    effort: KiroEffort | null,
  ): Promise<void> {
    if (this.#closed) throw new Error('Kiro ACP runtime is closed');
    if (this.#stopping) throw new Error('Kiro ACP runtime is stopping');
    const pending = session.ensureStarted(catalogProvider, effort);
    this.#pendingStartups.add(pending);
    try {
      await pending;
    } finally {
      this.#pendingStartups.delete(pending);
    }
    if (this.#closed) throw new Error('Kiro ACP runtime is closed');
  }

  /** Reusable host shutdown: stop every session, then accept new work again. */
  async stopAllSessions(): Promise<void> {
    this.#stopping = true;
    try {
      await this.#awaitPendingWork();
      await stopAllSessions(this.#sessions);
    } finally {
      this.#stopping = false;
    }
  }

  /** Final shutdown: the runtime stays closed. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#awaitPendingWork();
      await stopAllSessions(this.#sessions);
    })();
    return this.#closePromise;
  }

  /** Drop a terminal anonymous session and release its process. */
  releaseSession(session: AcpSession): void {
    // stopAll/close already owns every session during shutdown.
    if (this.#closed || this.#stopping) return;
    for (const [key, current] of this.#sessions) {
      if (current === session) this.#sessions.delete(key);
    }
    this.#trackTeardown(session.stop());
  }

  pruneIdleSessions(maxIdleMs = 10 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions) {
      if (!session.busy && now - session.lastUsedAt > maxIdleMs) {
        log('pruning idle session', {
          session: session.id,
          idleMs: now - session.lastUsedAt,
          key,
        });
        this.#sessions.delete(key);
        this.#trackTeardown(session.stop());
      }
    }
  }

  #trackTeardown(teardown: Promise<void>): void {
    this.#pendingTeardowns.add(teardown);
    void teardown.then(
      () => this.#pendingTeardowns.delete(teardown),
      () => this.#pendingTeardowns.delete(teardown),
    );
  }

  async #awaitPendingWork(): Promise<void> {
    while (
      this.#pendingRoutes.size > 0 ||
      this.#pendingStartups.size > 0 ||
      this.#pendingTeardowns.size > 0
    ) {
      await Promise.allSettled([
        ...this.#pendingRoutes,
        ...this.#pendingStartups,
        ...this.#pendingTeardowns,
      ]);
    }
  }
}
