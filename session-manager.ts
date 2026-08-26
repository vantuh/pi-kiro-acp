import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { extractToolResults } from "./helpers.ts";
import { log } from "./logging.ts";
import { AcpSession } from "./session.ts";
import { persistenceKeyForSession } from "./session-persistence.ts";
import type { ToolResultInfo } from "./types.ts";

const sessions = new Map<string, AcpSession>();

export interface RoutedSession {
	session: AcpSession;
	toolResults: ToolResultInfo[];
	isResumption: boolean;
	/**
	 * True when the context carries tool results but no pending bridge call
	 * matched them: Kiro abandoned its own tools/call before pi finished running
	 * the tool. The result can no longer be answered into that MCP request, so it
	 * has to be handed back as a follow-up prompt instead.
	 */
	orphanedToolResults: boolean;
}

/** Sessions that still hold a live Kiro conversation, most recently used first. */
function liveSessionsForKey(keyPrefix: string, cwd: string): AcpSession[] {
	return [...sessions.entries()]
		.filter(([key]) => key === keyPrefix || key.startsWith(`${keyPrefix}:`))
		.map(([, session]) => session)
		.filter((session) => session.started && !!session.acpSessionId && session.cwd === cwd)
		.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export async function routeSession(
	context: Context,
	options?: SimpleStreamOptions,
): Promise<RoutedSession> {
	const toolResults = extractToolResults(context);
	const sessionId =
		typeof options?.sessionId === "string" && options.sessionId
			? options.sessionId
			: undefined;
	const requestedCwd = (options as any)?.cwd || process.cwd();
	let orphanedToolResults = false;

	if (toolResults.length > 0) {
		const matches = [...sessions.values()]
			.map((session) => ({
				session,
				matches: session.matchingToolResults(toolResults).length,
			}))
			.filter((x) => x.matches > 0)
			.sort((a, b) => b.matches - a.matches);

		if (matches[0]) {
			log("route resumption", {
				session: matches[0].session.id,
				matches: matches[0].matches,
				toolResults: toolResults.length,
			});
			return {
				session: matches[0].session,
				toolResults,
				isResumption: true,
				orphanedToolResults: false,
			};
		}

		// No pending call to answer. Never fall through to "fresh session + replay"
		// here: a brand-new Kiro session would redo the work the tool just did.
		// Reuse the live session that still remembers the conversation and let the
		// stream deliver the result as a follow-up prompt instead.
		orphanedToolResults = true;
		log("route: no resumption match found", {
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
			? liveSessionsForKey(`pi:${sessionId}`, requestedCwd)[0]
			: undefined;
		if (reusable) {
			if (sessionId) reusable.persistenceKey = persistenceKeyForSession(sessionId, requestedCwd);
			log("route orphaned tool result to live session", {
				session: reusable.id,
				acpSessionId: reusable.acpSessionId,
				toolNames: toolResults.map((t) => t.toolName),
			});
			return { session: reusable, toolResults, isResumption: false, orphanedToolResults };
		}
		log("route orphaned tool result: no live session to recover into", {
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
			log("route existing keyed session", {
				session: existing.id,
				key,
				cwd: requestedCwd,
				busy: existing.busy,
				persistenceKey,
			});
			return { session: existing, toolResults, isResumption: false, orphanedToolResults };
		}

		const created = new AcpSession(requestedCwd);
		const actualKey = existing?.busy ? `${key}:parallel:${created.id}` : key;
		created.persistenceKey = actualKey === key ? persistenceKey : null;
		sessions.set(actualKey, created);
		log("route new keyed session", {
			session: created.id,
			key: actualKey,
			originalKey: key,
			cwd: requestedCwd,
			existingBusy: !!existing?.busy,
			persistenceKey: created.persistenceKey,
		});
		return { session: created, toolResults, isResumption: false, orphanedToolResults };
	}

	const idleSameCwd = [...sessions.values()].find(
		(s) => !s.busy && s.cwd === requestedCwd,
	);
	if (idleSameCwd) {
		idleSameCwd.persistenceKey = null;
		log("route idle same-cwd session", {
			session: idleSameCwd.id,
			cwd: requestedCwd,
		});
		return { session: idleSameCwd, toolResults, isResumption: false, orphanedToolResults };
	}

	const created = new AcpSession(requestedCwd);
	created.persistenceKey = null;
	sessions.set(`anon:${created.id}`, created);
	log("route new anon session", {
		session: created.id,
		cwd: requestedCwd,
		activeSessions: sessions.size,
	});
	return { session: created, toolResults, isResumption: false, orphanedToolResults };
}

export async function stopAllSessions(): Promise<void> {
	const all = [...sessions.values()];
	sessions.clear();
	await Promise.allSettled(all.map((s) => s.stop()));
}

export function pruneIdleSessions(maxIdleMs = 10 * 60 * 1000): void {
	const now = Date.now();
	for (const [key, session] of sessions) {
		if (!session.busy && now - session.lastUsedAt > maxIdleMs) {
			log("pruning idle session", {
				session: session.id,
				idleMs: now - session.lastUsedAt,
				key,
			});
			sessions.delete(key);
			void session.stop();
		}
	}
}

export function activeSessionCount(): number {
	return sessions.size;
}
