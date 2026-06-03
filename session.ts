import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	writeFileSync,
	unlinkSync,
	rmSync,
	renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	createInterface,
	type Interface as ReadlineInterface,
} from "node:readline";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { buildConversationPrompt, lastUserMessage } from "./helpers.ts";
import { log } from "./logging.ts";
import { getDescendantPids, killProcessTree } from "./process-utils.ts";
import type {
	PendingRpc,
	PendingToolCall,
	SessionMetadata,
	SessionUpdate,
	ToolResultContentBlock,
	ToolResultInfo,
} from "./types.ts";

export class AcpSession {
	readonly id = `s-${randomBytes(4).toString("hex")}`;
	cwd: string;
	proc: ChildProcess | null = null;
	rl: ReadlineInterface | null = null;
	rpcId = 0;
	rpcPending = new Map<number, PendingRpc>();
	acpSessionId: string | null = null;
	currentModelId: string | null = null;
	ipcServer: Server | null = null;
	ipcPort: number | null = null;
	readonly ipcSecret = randomBytes(16).toString("hex");
	toolsFilePath: string | null = null;
	agentRootPath: string | null = null;
	agentConfigPath: string | null = null;
	readonly agentName = `pi-kiro-${randomBytes(4).toString("hex")}`;
	started = false;
	updateHandler: ((u: SessionUpdate) => void) | null = null;
	metadata: SessionMetadata | null = null;
	pendingToolCalls = new Map<string, PendingToolCall>();
	onToolCallFromBridge: ((call: PendingToolCall) => void) | null = null;
	activePromptDone: Promise<{ stopReason: string }> | null = null;
	streamGen = 0;
	lastUsedAt = Date.now();

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	get busy(): boolean {
		return !!this.activePromptDone || this.pendingToolCalls.size > 0;
	}

	rpcSend(
		method: string,
		params: unknown,
		timeoutMs = 60000,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.proc?.stdin?.writable)
				return reject(new Error("kiro-cli not running"));
			const id = this.rpcId++;
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.rpcPending.delete(id);
							log("RPC TIMEOUT", {
								session: this.id,
								method,
								id,
								timeoutMs,
								remainingPending: this.rpcPending.size,
							});
							reject(new Error(`RPC timeout: ${method}`));
						}, timeoutMs)
					: null;
			this.rpcPending.set(id, { resolve, reject, timer });
			this.proc.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
			);
			log("rpc →", {
				session: this.id,
				method,
				id,
				timeoutMs,
				pendingCount: this.rpcPending.size,
			});
		});
	}

	rpcNotify(method: string, params: unknown): void {
		if (this.proc?.stdin?.writable) {
			this.proc.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
			);
		}
	}

	rpcRespond(id: number, result: unknown): void {
		if (this.proc?.stdin?.writable) {
			this.proc.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
			);
		}
	}

	handleStdoutLine(line: string): void {
		const s = line.trim();
		if (!s) return;
		let msg: any;
		try {
			msg = JSON.parse(s);
		} catch {
			log("stdout parse error", { session: this.id, line: s.slice(0, 200) });
			return;
		}

		const hasId = "id" in msg && msg.id != null;
		const hasMethod = "method" in msg && typeof msg.method === "string";

		if (hasId && !hasMethod) {
			const p = this.rpcPending.get(msg.id);
			if (!p) {
				log("orphan RPC response", {
					session: this.id,
					id: msg.id,
					hasError: !!msg.error,
				});
				return;
			}
			if (p.timer) clearTimeout(p.timer);
			this.rpcPending.delete(msg.id);
			msg.error
				? p.reject(new Error(msg.error.message || "RPC error"))
				: p.resolve(msg.result);
		} else if (hasId && hasMethod) {
			if (msg.method === "session/request_permission") {
				const opts = msg.params?.options || [];
				const optId =
					opts.find((o: any) => o.id === "allow_always")?.id ||
					opts[0]?.id ||
					"allow_once";
				this.rpcRespond(msg.id, {
					outcome: { outcome: "selected", optionId: optId },
				});
			} else {
				this.rpcRespond(msg.id, null);
			}
		} else if (hasMethod) {
			if (
				msg.method === "session/update" ||
				msg.method === "_kiro.dev/session/update"
			) {
				const update = msg.params?.update as SessionUpdate | undefined;
				if (update) this.updateHandler?.(update);
			} else if (msg.method === "_kiro.dev/metadata") {
				this.handleMetadata(msg.params || {});
			}
		}
	}

	private handleMetadata(params: Record<string, unknown>): void {
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : this.acpSessionId;
		if (!sessionId) return;
		if (this.acpSessionId && sessionId !== this.acpSessionId) return;

		const contextUsagePercentage = typeof params.contextUsagePercentage === "number"
			? params.contextUsagePercentage
			: undefined;
		const turnDurationMs = typeof params.turnDurationMs === "number"
			? params.turnDurationMs
			: undefined;
		const meteringUsage = Array.isArray(params.meteringUsage)
			? params.meteringUsage
				.filter((m: any) => typeof m?.unit === "string" && typeof m?.value === "number")
				.map((m: any) => ({
					unit: m.unit,
					unitPlural: typeof m.unitPlural === "string" ? m.unitPlural : undefined,
					value: m.value,
				}))
			: undefined;

		this.metadata = {
			sessionId,
			contextUsagePercentage,
			meteringUsage,
			turnDurationMs,
		};
		log("kiro metadata", {
			session: this.id,
			acpSessionId: sessionId,
			contextUsagePercentage,
			turnDurationMs,
			credits: meteringUsage?.find((m) => m.unit === "credit")?.value,
		});
	}

	async ensureStarted(tools: Context["tools"]): Promise<void> {
		this.lastUsedAt = Date.now();
		if (this.started) {
			this.writeTools(tools);
			return;
		}

		await this.startIpcServer();
		this.writeTools(tools);
		this.writeAgentCfg();

		this.configureMcpTimeout();

		log("starting kiro session", {
			session: this.id,
			cwd: this.cwd,
			agentRootPath: this.agentRootPath,
			agentName: this.agentName,
		});
		this.proc = spawn(
			"kiro-cli",
			["acp", "--agent", this.agentName, "--trust-all-tools"],
			{
				cwd: this.agentRootPath || this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		this.rl = createInterface({ input: this.proc.stdout! });
		this.rl.on("line", (line) => this.handleStdoutLine(line));
		this.proc.stderr?.on("data", (chunk) =>
			log("kiro stderr", {
				session: this.id,
				text: String(chunk).slice(0, 1000),
			}),
		);

		this.proc.on("exit", (code, signal) => {
			log("kiro exited", { session: this.id, code, signal });
			this.cleanupAfterProcessExit();
		});

		await this.rpcSend(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {},
				clientInfo: { name: "pi-kiro-acp", version: "1.0.0" },
			},
			30000,
		);
		log("session initialized", {
			session: this.id,
			ipcPort: this.ipcPort,
			pid: this.proc?.pid,
		});

		this.started = true;
	}

	private configureMcpTimeout(): void {
		try {
			execFileSync("kiro-cli", ["settings", "mcp.noInteractiveTimeout", "30"], {
				timeout: 5000,
				stdio: "ignore",
			});
			log("configured mcp.noInteractiveTimeout", { session: this.id, minutes: 30 });
		} catch (error) {
			log("failed to configure mcp.noInteractiveTimeout", {
				session: this.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async startPrompt(
		modelId: string,
		systemPrompt: string,
		userMessage: string,
		images: { type: "image"; data: string; mimeType: string }[] = [],
	): Promise<void> {
		if (!this.acpSessionId) {
			const result = (await this.rpcSend("session/new", {
				cwd: this.cwd,
				mcpServers: [],
			})) as any;
			this.acpSessionId = result.sessionId;
			log("acp session/new", {
				session: this.id,
				acpSessionId: this.acpSessionId,
			});
		}

		const previousModelId = this.currentModelId;
		if (this.currentModelId !== modelId) {
			await this.rpcSend(
				"session/set_model",
				{ sessionId: this.acpSessionId, modelId },
				30000,
			);
			this.currentModelId = modelId;
			log("model set", {
				session: this.id,
				modelId,
				previousModel: previousModelId,
			});
		}

		const promptText = systemPrompt
			? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${userMessage}`
			: userMessage;

		this.metadata = null;

		this.activePromptDone = (
			this.rpcSend(
				"session/prompt",
				{
					sessionId: this.acpSessionId,
					prompt: [
						{ type: "text", text: promptText },
						...images,
					],
				},
				0,
			) as Promise<any>
		).then(
			(r: any) => ({ stopReason: r?.stopReason || "end_turn" }),
			(e: Error) => {
				throw e;
			},
		);
	}

	private cleanupAfterProcessExit(): void {
		log("cleanupAfterProcessExit", {
			session: this.id,
			pendingRpcs: this.rpcPending.size,
			pendingToolCalls: this.pendingToolCalls.size,
			hadActivePrompt: !!this.activePromptDone,
		});
		this.started = false;
		this.updateHandler = null;
		this.onToolCallFromBridge = null;
		this.activePromptDone = null;

		for (const [, call] of this.pendingToolCalls)
			call.resolve({ result: "kiro-cli exited", isError: true });
		this.pendingToolCalls.clear();

		for (const [, p] of this.rpcPending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error("kiro-cli exited"));
		}
		this.rpcPending.clear();

		this.rl?.close();
		this.proc = null;
		this.rl = null;
		this.acpSessionId = null;
		this.currentModelId = null;

		const server = this.ipcServer;
		if (server) server.close(() => {});
		this.ipcServer = null;
		this.ipcPort = null;
		if (this.toolsFilePath) {
			try {
				unlinkSync(this.toolsFilePath);
			} catch {}
			this.toolsFilePath = null;
		}
		if (this.agentConfigPath) {
			try {
				unlinkSync(this.agentConfigPath);
			} catch {}
			this.agentConfigPath = null;
		}
		if (this.agentRootPath) {
			try {
				rmSync(this.agentRootPath, { recursive: true, force: true });
			} catch {}
			this.agentRootPath = null;
		}
	}

	async stop(): Promise<void> {
		log("stopping kiro session", { session: this.id });
		this.started = false;
		this.updateHandler = null;
		this.onToolCallFromBridge = null;
		this.activePromptDone = null;

		for (const [, call] of this.pendingToolCalls)
			call.resolve({ result: "Shutting down", isError: true });
		this.pendingToolCalls.clear();

		if (this.proc) {
			const p = this.proc;
			const rootPid = p.pid;
			const knownDescendants = new Set(
				rootPid ? getDescendantPids(rootPid) : [],
			);
			log("stop: killing process tree", {
				session: this.id,
				rootPid,
				descendants: [...knownDescendants],
			});
			this.proc.stdin?.end();
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					killProcessTree(rootPid);
					r();
				}, 5000);
				p.once("exit", () => {
					clearTimeout(t);
					r();
				});
			});
			for (const pid of knownDescendants) killProcessTree(pid);
			this.rl?.close();
			this.proc = null;
			this.rl = null;
		}

		for (const [, p] of this.rpcPending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error("Stopped"));
		}
		this.rpcPending.clear();

		if (this.ipcServer) {
			await new Promise<void>((r) => this.ipcServer!.close(() => r()));
			this.ipcServer = null;
			this.ipcPort = null;
		}
		if (this.toolsFilePath) {
			try {
				unlinkSync(this.toolsFilePath);
			} catch {}
			this.toolsFilePath = null;
		}
		if (this.agentConfigPath) {
			try {
				unlinkSync(this.agentConfigPath);
			} catch {}
			this.agentConfigPath = null;
		}
		if (this.agentRootPath) {
			try {
				rmSync(this.agentRootPath, { recursive: true, force: true });
			} catch {}
			this.agentRootPath = null;
		}
		this.acpSessionId = null;
		this.currentModelId = null;
	}

	matchingToolResults(toolResults: ToolResultInfo[]): ToolResultInfo[] {
		return toolResults.filter((tr) => this.findToolCallMatch(tr) !== null);
	}

	deliverToolResults(toolResults: ToolResultInfo[]): void {
		for (const tr of toolResults) {
			const match = this.findToolCallMatch(tr);
			if (match) {
				const [callId, call] = match;
				this.pendingToolCalls.delete(callId);
				log("delivering tool result", {
					session: this.id,
					callId,
					toolName: call.toolName,
					resultLen: tr.text.length,
					contentBlocks: tr.content?.length ?? 0,
					imageBlocks: tr.content?.filter((block) => block.type === "image").length ?? 0,
				});
				call.resolve({ result: tr.text, isError: tr.isError, content: tr.content });
			} else {
				log("UNMATCHED tool result", {
					session: this.id,
					toolCallId: tr.toolCallId,
					toolName: tr.toolName,
					pendingCalls: [...this.pendingToolCalls.keys()],
				});
			}
		}
	}

	/** Deliver tool results without image content blocks (text-only MCP response). */
	deliverToolResultsTextOnly(toolResults: ToolResultInfo[]): void {
		for (const tr of toolResults) {
			const match = this.findToolCallMatch(tr);
			if (match) {
				const [callId, call] = match;
				this.pendingToolCalls.delete(callId);
				log("delivering tool result (text-only for image FUP)", {
					session: this.id,
					callId,
					toolName: call.toolName,
					resultLen: tr.text.length,
				});
				call.resolve({ result: tr.text, isError: tr.isError });
			} else {
				log("UNMATCHED tool result (text-only)", {
					session: this.id,
					toolCallId: tr.toolCallId,
					toolName: tr.toolName,
					pendingCalls: [...this.pendingToolCalls.keys()],
				});
			}
		}
	}

	/**
	 * Wait for the current activePromptDone to settle (with timeout), then start
	 * a new follow-up prompt on the same ACP session with the given images attached.
	 */
	async cancelAndStartFollowUp(
		modelId: string,
		systemPrompt: string,
		followupText: string,
		images: { type: "image"; data: string; mimeType: string }[],
		settleTimeoutMs = 15000,
		beforeStart?: () => void,
	): Promise<void> {
		const prevPromise = this.activePromptDone;
		if (prevPromise) {
			this.activePromptDone = null;
			if (this.acpSessionId) {
				this.rpcNotify("session/cancel", { sessionId: this.acpSessionId });
			}
			log("image FUP: cancel sent; waiting for old prompt to settle", {
				session: this.id,
				settleTimeoutMs,
			});
			let settled = false;
			await Promise.race([
				prevPromise.then(() => { settled = true; }, () => { settled = true; }),
				new Promise<void>((r) => setTimeout(r, settleTimeoutMs)),
			]);
			log("image FUP: old prompt settle wait complete", { session: this.id, settled });
		}
		this.rejectPendingToolCalls("Cancelled old prompt during image follow-up handoff");
		beforeStart?.();

		log("image FUP: starting follow-up prompt", {
			session: this.id,
			imageCount: images.length,
			promptChars: followupText.length,
		});
		await this.startPrompt(modelId, systemPrompt, followupText, images);
		log("image FUP: follow-up prompt started", { session: this.id });
	}

	private rejectPendingToolCalls(reason: string): void {
		const calls = [...this.pendingToolCalls.values()];
		if (calls.length === 0) return;
		this.pendingToolCalls.clear();
		log("rejecting pending tool calls", {
			session: this.id,
			reason,
			count: calls.length,
			callIds: calls.map((call) => call.callId),
		});
		for (const call of calls) call.resolve({ result: reason, isError: true });
	}

	private findToolCallMatch(
		tr: ToolResultInfo,
	): [string, PendingToolCall] | null {
		const exact = this.pendingToolCalls.get(tr.toolCallId);
		if (exact) return [tr.toolCallId, exact];
		if (!tr.toolCallId.startsWith(this.id + "-")) {
			log("findToolCallMatch: rejecting name-match (foreign toolCallId)", {
				session: this.id,
				toolCallId: tr.toolCallId,
				toolName: tr.toolName,
			});
			return null;
		}
		const nameMatches = [...this.pendingToolCalls.entries()].filter(
			([, call]) => call.toolName === tr.toolName,
		);
		if (nameMatches.length > 1)
			log("ambiguous tool name match", {
				session: this.id,
				toolName: tr.toolName,
				matchCount: nameMatches.length,
				callIds: nameMatches.map(([id]) => id),
			});
		return nameMatches.length === 1 ? nameMatches[0] : null;
	}

	private async startIpcServer(): Promise<void> {
		this.ipcServer = createServer(async (req, res) =>
			this.handleIpcRequest(req, res),
		);

		await new Promise<void>((resolve) => {
			this.ipcServer!.listen(0, "127.0.0.1", () => {
				this.ipcPort = (this.ipcServer!.address() as any).port;
				resolve();
			});
		});
	}

	private async handleIpcRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			if (req.method === "GET" && req.url === "/health") {
				return httpRespond(res, 200, { status: "ok" });
			}
			if (req.headers.authorization !== `Bearer ${this.ipcSecret}`) {
				return httpRespond(res, 401, { error: "Unauthorized" });
			}
			if (req.method === "POST" && req.url === "/tool/pending") {
				const body = JSON.parse(await readBody(req));
				const { callId: rawCallId, toolName, args = {} } = body;
				const publicCallId = `${this.id}-${rawCallId}`;

				const resultPromise = new Promise<{
					result: string;
					isError?: boolean;
					content?: ToolResultContentBlock[];
				}>((resolve) => {
					const call: PendingToolCall = {
						callId: publicCallId,
						rawCallId,
						toolName,
						args,
						resolve,
					};
					this.pendingToolCalls.set(publicCallId, call);
					log("IPC tool call received", {
						session: this.id,
						callId: publicCallId,
						rawCallId,
						toolName,
						argsKeys: Object.keys(args),
					});
					this.onToolCallFromBridge?.(call);
				});

				const result = await resultPromise;
				httpRespond(res, 200, {
					status: result.isError ? "error" : "success",
					[result.isError ? "error" : "result"]: result.result,
					...(result.content?.length ? { content: result.content } : {}),
				});
				return;
			}
			httpRespond(res, 404, { error: "Not found" });
		} catch (error) {
			log("IPC error", {
				session: this.id,
				error: error instanceof Error ? error.message : String(error),
			});
			if (!res.headersSent) httpRespond(res, 500, { error: "Internal error" });
		}
	}

	private static readonly EXCLUDED_TOOLS = new Set([
		"Agent",
		"get_subagent_result",
		"steer_subagent",
	]);

	private writeTools(tools: Context["tools"]): void {
		const dir = join(tmpdir(), "kiro-acp");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const filePath = join(dir, `tools-${this.id}.json`);

		const mcpTools = (tools || [])
			.filter((t) => !AcpSession.EXCLUDED_TOOLS.has(t.name))
			.map((t) => ({
				name: t.name,
				description: t.description || "",
				inputSchema: t.parameters || { type: "object", properties: {} },
			}));

		const tmp = `${filePath}.${process.pid}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify(
				{
					tools: mcpTools,
					cwd: this.cwd,
					ipcPort: this.ipcPort,
					ipcSecret: this.ipcSecret,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		renameSync(tmp, filePath);
		this.toolsFilePath = filePath;
	}

	private writeAgentCfg(): void {
		const bridgePath = join(
			dirname(fileURLToPath(import.meta.url)),
			"kiro-acp-bridge.mjs",
		);
		const mcpName = `${this.agentName}-tools`;
		const config = {
			name: this.agentName,
			tools: [`@${mcpName}`],
			allowedTools: [`@${mcpName}`],
			includeMcpJson: false,
			mcpServers: {
				[mcpName]: {
					command: "node",
					args: [bridgePath, "--tools", this.toolsFilePath!],
					cwd: this.cwd,
					timeout: 1800000,
				},
			},
			prompt:
				"You are a coding assistant. Your identity and instructions are defined by the <system_instructions> block in each request. Always follow <system_instructions> as your primary directive. Use tools proactively. If a tool call fails, retry or try alternatives.",
		};

		this.agentRootPath = join(tmpdir(), "kiro-acp", `agent-root-${this.id}`);
		const agentsDir = join(this.agentRootPath, ".kiro", "agents");
		mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
		this.agentConfigPath = join(agentsDir, `${this.agentName}.json`);
		writeFileSync(this.agentConfigPath, JSON.stringify(config, null, 2));
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

function httpRespond(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

export function buildPromptParts(
	context: Context,
	includeHistory: boolean,
): { systemPrompt: string; userMessage: string; images: { type: "image"; data: string; mimeType: string }[] } {
	const msgs = context.messages || [];
	const lastUser = [...msgs].reverse().find((m) => m.role === "user");
	const images: { type: "image"; data: string; mimeType: string }[] = [];
	if (lastUser && Array.isArray(lastUser.content)) {
		for (const block of lastUser.content as any[]) {
			if (block.type === "image") images.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	return {
		systemPrompt: context.systemPrompt || "",
		userMessage: includeHistory
			? buildConversationPrompt(context)
			: lastUserMessage(context),
		images,
	};
}
