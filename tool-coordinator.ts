import type { ToolBridgeCall, ToolBridgeResult } from "./tool-bridge.ts";

export interface ForwardedCall extends ToolBridgeCall {
	piToolCallId: string;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

interface PromptState {
	handoffs: ForwardedCall[];
	waiters: Set<Deferred<ForwardedCall>>;
}

interface PendingCall {
	call: ForwardedCall;
	result: Deferred<ToolBridgeResult>;
	signal: AbortSignal;
	onAbort: () => void;
}

/** Coordinates one suspended ACP prompt with Pi's next outer tool turn. */
export class KiroToolCoordinator {
	private prompt: PromptState | undefined;
	private pending: PendingCall | undefined;
	private nextToolCallId = 1;
	private readonly idPrefix: string;

	constructor(idPrefix: string) {
		this.idPrefix = idPrefix;
	}

	startPrompt(): void {
		if (this.prompt) throw new Error("An ACP prompt is already active");
		this.prompt = { handoffs: [], waiters: new Set() };
	}

	finishPrompt(): void {
		const prompt = this.prompt;
		this.prompt = undefined;
		this.rejectPending(new Error("ACP prompt finished"));
		if (!prompt) return;
		for (const waiter of prompt.waiters) waiter.reject(new Error("ACP prompt finished"));
		prompt.waiters.clear();
	}

	/** Called by the MCP adapter when Kiro asks Pi to execute a tool. */
	beginCall(call: ToolBridgeCall): Promise<ToolBridgeResult> {
		if (!this.prompt) return Promise.reject(new Error("No ACP prompt is waiting for a tool call"));
		if (this.pending) return Promise.reject(new Error("A forwarded Pi tool call is already pending"));
		if (call.signal.aborted) return Promise.reject(new Error("Kiro tool call aborted before dispatch"));
		const forwarded: ForwardedCall = {
			...call,
			// MCP request ids only correlate one HTTP request; Pi transcript ids
			// must remain unique even when a client reuses an MCP id.
			piToolCallId: `${this.idPrefix}${this.nextToolCallId++}`,
		};
		const result = deferred<ToolBridgeResult>();
		// The bridge aborts this signal when the MCP client disconnects; propagate
		// that to the suspended prompt so a stale pending call cannot linger.
		const onAbort = () => this.rejectPending(new Error("Kiro tool call aborted"));
		this.pending = { call: forwarded, result, signal: call.signal, onAbort };
		call.signal.addEventListener("abort", onAbort, { once: true });
		if (this.prompt.waiters.size > 0) {
			const waiter = this.prompt.waiters.values().next().value as Deferred<ForwardedCall>;
			this.prompt.waiters.delete(waiter);
			waiter.resolve(forwarded);
		} else {
			this.prompt.handoffs.push(forwarded);
		}
		return result.promise;
	}

	waitForHandoff(): Promise<ForwardedCall> {
		if (!this.prompt) return Promise.reject(new Error("No ACP prompt is active"));
		const queued = this.prompt.handoffs.shift();
		if (queued) return Promise.resolve(queued);
		const waiter = deferred<ForwardedCall>();
		this.prompt.waiters.add(waiter);
		return waiter.promise;
	}

	get pendingCall(): ForwardedCall | undefined {
		return this.pending?.call;
	}

	/** Resolve the MCP request from Pi's authoritative tool result. */
	resolveToolResult(toolCallId: string, toolName: string, result: ToolBridgeResult): boolean {
		const pending = this.pending;
		if (!pending || pending.call.piToolCallId !== toolCallId || pending.call.piName !== toolName) return false;
		this.takePending();
		pending.result.resolve(result);
		return true;
	}

	rejectPending(error: Error): void {
		const pending = this.takePending();
		pending?.result.reject(error);
	}

	/** Detach the current pending call and stop listening for its abort signal. */
	private takePending(): PendingCall | undefined {
		const pending = this.pending;
		this.pending = undefined;
		if (pending) pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}
}
