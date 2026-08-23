import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ForwardedTool, ForwardedToolCatalog } from "./tool-catalog.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 64 * 1024;

type JsonRpcId = number | string | null;
type JsonRpcMessage = {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
};

export interface ToolBridgeContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface ToolBridgeResult {
	content: ToolBridgeContent[];
	isError?: boolean;
}

export interface ToolBridgeCall {
	requestId: JsonRpcId;
	kiroName: string;
	piName: string;
	arguments: Record<string, unknown>;
	signal: AbortSignal;
}

export type ToolBridgeCatalog = ForwardedToolCatalog | (() => ForwardedToolCatalog);
export type ToolBridgeCallHandler = (call: ToolBridgeCall) => Promise<ToolBridgeResult>;

export interface ToolBridgeOptions {
	catalog: ToolBridgeCatalog;
	onToolCall: ToolBridgeCallHandler;
	/** Exact Origin values accepted when a client sends an Origin header. */
	allowedOrigins?: readonly string[];
	maxBodyBytes?: number;
}

export interface ToolBridge {
	readonly token: string;
	readonly url: string;
	readonly port: number;
	close(): Promise<void>;
}

interface PendingCall {
	response: ServerResponse;
	abort: AbortController;
	reject: (error: Error) => void;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
	if (res.writableEnded || res.destroyed) return;
	if (body === undefined) {
		res.writeHead(status, headers);
		res.end();
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(payload);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("request body too large");
	}
	return body;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return value === null || typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function textResult(text: string, isError = false): ToolBridgeResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function resolveCatalog(source: ToolBridgeCatalog): ForwardedToolCatalog {
	return typeof source === "function" ? source() : source;
}

function validOrigin(origin: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
	// Kiro 2.5.0 sends no Origin. Keep that compatibility behavior while
	// rejecting every supplied origin unless explicitly allowed by the caller.
	return origin === undefined || allowedOrigins.has(origin);
}

function validAccept(header: string | undefined): boolean {
	if (!header) return true;
	return header.split(",").some((part) => {
		const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
		return mediaType === "application/json" || mediaType === "text/event-stream" || mediaType === "*/*";
	});
}

/** Start a minimal authenticated Streamable HTTP MCP server on loopback. */
export async function startToolBridge(options: ToolBridgeOptions): Promise<ToolBridge> {
	const token = randomBytes(32).toString("hex");
	const allowedOrigins = new Set(options.allowedOrigins ?? []);
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	let pending: PendingCall | undefined;
	let closed = false;

	const server = createServer(async (req, res) => {
		const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
		if (pathname !== "/mcp") {
			sendJson(res, 404, jsonRpcError(null, -32601, "Not found"));
			return;
		}

		const authorization = req.headers.authorization;
		if (authorization !== `Bearer ${token}`) {
			sendJson(res, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
			return;
		}
		if (!validOrigin(req.headers.origin, allowedOrigins)) {
			sendJson(res, 403, { error: "Origin not allowed" });
			return;
		}
		if (!validAccept(req.headers.accept)) {
			sendJson(res, 406, { error: "Accept must include application/json or text/event-stream" });
			return;
		}

		if (req.method === "DELETE") {
			sendJson(res, 202);
			void closeBridge();
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, jsonRpcError(null, -32601, "Method not allowed"), { allow: "POST, DELETE" });
			return;
		}

		let message: JsonRpcMessage;
		try {
			const body = await readBody(req, maxBodyBytes);
			const parsed = JSON.parse(body) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid request");
			message = parsed as JsonRpcMessage;
		} catch (error) {
			const tooLarge = error instanceof Error && error.message === "request body too large";
			sendJson(res, tooLarge ? 413 : 400, jsonRpcError(null, tooLarge ? -32600 : -32700, tooLarge ? "Request body too large" : "Invalid JSON"));
			return;
		}

		const id = isJsonRpcId(message.id) ? message.id : undefined;
		if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
			sendJson(res, 400, jsonRpcError(id, -32600, "Invalid JSON-RPC request"));
			return;
		}
		if (message.method === "notifications/initialized") {
			sendJson(res, 202);
			return;
		}
		if (id === undefined) {
			sendJson(res, 400, jsonRpcError(null, -32600, "Request id is required"));
			return;
		}

		switch (message.method) {
			case "initialize": {
				const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
				const protocolVersion = requested === MCP_PROTOCOL_VERSION || requested === "2024-11-05" ? requested : MCP_PROTOCOL_VERSION;
				sendJson(res, 200, jsonRpcResult(id, {
					protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "pi_host", version: "1.0.0" },
				}));
				return;
			}
			case "tools/list": {
				const catalog = resolveCatalog(options.catalog);
				const tools = catalog.tools.map((tool: ForwardedTool) => ({
					name: tool.kiroName,
					description: tool.description,
					inputSchema: tool.parameters,
				}));
				sendJson(res, 200, jsonRpcResult(id, { tools }));
				return;
			}
			case "prompts/list":
				sendJson(res, 200, jsonRpcResult(id, { prompts: [] }));
				return;
			case "resources/list":
				sendJson(res, 200, jsonRpcResult(id, { resources: [] }));
				return;
			case "tools/call": {
				if (pending) {
					sendJson(res, 200, jsonRpcError(id, -32000, "Another tool call is already pending"));
					return;
				}
				const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
				if (typeof params?.name !== "string") {
					sendJson(res, 200, jsonRpcError(id, -32602, "Tool name is required"));
					return;
				}
				const catalog = resolveCatalog(options.catalog);
				const piName = catalog.piNameByKiroName.get(params.name);
				if (!piName) {
					sendJson(res, 200, jsonRpcError(id, -32602, "Unknown tool"));
					return;
				}
				const args = params.arguments === undefined ? {} : params.arguments;
				if (!args || typeof args !== "object" || Array.isArray(args)) {
					sendJson(res, 200, jsonRpcError(id, -32602, "Tool arguments must be an object"));
					return;
				}
				const abort = new AbortController();
				const callPromise = new Promise<ToolBridgeResult>((resolve, reject) => {
					pending = { response: res, abort, reject };
					void options.onToolCall({
						requestId: id,
						kiroName: params.name as string,
						piName,
						arguments: args as Record<string, unknown>,
						signal: abort.signal,
					}).then(resolve, reject);
				});
				const clearPending = () => {
					if (pending?.response === res) pending = undefined;
				};
				res.once("close", () => {
					if (res.writableEnded || pending?.response !== res) return;
					abort.abort();
					pending.reject(new Error("MCP client disconnected"));
					clearPending();
				});
				try {
					const result = await callPromise;
					clearPending();
					sendJson(res, 200, jsonRpcResult(id, result));
				} catch (error) {
					clearPending();
					if (!res.destroyed) sendJson(res, 200, jsonRpcResult(id, textResult(error instanceof Error ? error.message : String(error), true)));
				}
				return;
			}
			default:
				sendJson(res, 200, jsonRpcError(id, -32601, "Method not found"));
		}
	});

	const closeBridge = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (pending) {
			pending.abort.abort();
			pending.reject(new Error("MCP adapter closed"));
			pending.response.destroy();
			pending = undefined;
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await closeBridge();
		throw new Error("MCP adapter did not bind to a TCP port");
	}
	return {
		token,
		port: address.port,
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: closeBridge,
	};
}
