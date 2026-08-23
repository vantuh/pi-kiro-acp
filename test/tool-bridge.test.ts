// Test: authenticated loopback Streamable HTTP MCP adapter.
// Run: jiti test/tool-bridge.test.ts

import { request as httpRequest, type ClientRequest } from "node:http";
import { buildForwardedToolCatalog } from "../tool-catalog.ts";
import { startToolBridge } from "../tool-bridge.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

const catalog = buildForwardedToolCatalog([
	{
		name: "probe_tool",
		description: "A probe tool",
		parameters: { type: "object", properties: { value: { type: "string" } } },
		sourceInfo: { source: "package" },
	},
], ["probe_tool"]);

interface Response {
	status: number;
	body: any;
}

function post(url: string, token: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const payload = JSON.stringify(body);
		const req = httpRequest({
			host: parsed.hostname,
			port: Number(parsed.port),
			path: parsed.pathname,
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(payload), ...headers },
		}, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				let parsedBody: any = undefined;
				try { parsedBody = text ? JSON.parse(text) : undefined; } catch { parsedBody = text; }
				resolve({ status: res.statusCode || 0, body: parsedBody });
			});
		});
		req.on("error", reject);
		req.end(payload);
	});
}

function rawPost(url: string, token: string, body: unknown): { request: ClientRequest; response: Promise<Response> } {
	const parsed = new URL(url);
	const payload = JSON.stringify(body);
	let resolveResponse!: (response: Response) => void;
	let rejectResponse!: (error: Error) => void;
	const response = new Promise<Response>((resolve, reject) => {
		resolveResponse = resolve;
		rejectResponse = reject;
	});
	const req = httpRequest({
		host: parsed.hostname,
		port: Number(parsed.port),
		path: parsed.pathname,
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(payload) },
	}, (res) => {
		let text = "";
		res.setEncoding("utf8");
		res.on("data", (chunk) => { text += chunk; });
		res.on("end", () => {
			let parsedBody: any = undefined;
			try { parsedBody = text ? JSON.parse(text) : undefined; } catch { parsedBody = text; }
			resolveResponse({ status: res.statusCode || 0, body: parsedBody });
		});
	});
	req.on("error", rejectResponse);
	req.end(payload);
	return { request: req, response };
}

function del(url: string, token: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const req = httpRequest({
			host: parsed.hostname,
			port: Number(parsed.port),
			path: parsed.pathname,
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		}, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode || 0));
		});
		req.on("error", reject);
		req.end();
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
	let resolveCall: (() => void) | undefined;
	let callStarted: ((call: any) => void) | undefined;
	const bridge = await startToolBridge({
		catalog,
		onToolCall: async (call) => {
			callStarted?.(call);
			await new Promise<void>((resolve) => { resolveCall = resolve; });
			return { content: [{ type: "text", text: JSON.stringify(call.arguments) }] };
		},
	});
	assert(bridge.url.startsWith("http://127.0.0.1:"), "adapter binds to loopback");
	assert(bridge.token.length >= 64, "adapter token has sufficient entropy");

	const initialized = await post(bridge.url, bridge.token, {
		jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
	}, { accept: "application/json, text/event-stream" });
	assert(initialized.status === 200, "initialize returns HTTP 200");
	assert(initialized.body.result?.capabilities?.tools, "initialize advertises tools capability");

	const notification = await post(bridge.url, bridge.token, { jsonrpc: "2.0", method: "notifications/initialized" });
	assert(notification.status === 202 && notification.body === undefined, "initialized notification returns 202 without a body");

	const listed = await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert(listed.body.result?.tools?.[0]?.name === "probe_tool", "tools/list returns the current catalog");
	assert(listed.body.result?.tools?.[0]?.inputSchema === undefined || listed.body.result.tools[0].inputSchema.type === "object", "tools/list returns inputSchema");

	let received: any;
	const started = new Promise<void>((resolve) => { callStarted = (call) => { received = call; resolve(); }; });
	const callPromise = post(bridge.url, bridge.token, {
		jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe_tool", arguments: { value: "ok" } },
	});
	await started;
	await wait(20);
	let settled = false;
	void callPromise.finally(() => { settled = true; });
	await wait(20);
	assert(!settled, "tools/call remains pending until Pi resolves it");
	assert(received?.piName === "probe_tool" && received.arguments.value === "ok", "tools/call maps alias and arguments");
	resolveCall!();
	const called = await callPromise;
	assert(called.body.result?.content?.[0]?.text === '{"value":"ok"}', "successful tool result returns MCP content");

	const unknown = await post(bridge.url, bridge.token, {
		jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "missing_tool", arguments: {} },
	});
	assert(unknown.body.error?.code === -32602, "unknown tool is rejected before Pi execution");

	const unauthorized = await post(bridge.url, "wrong-token", { jsonrpc: "2.0", id: 5, method: "tools/list" });
	assert(unauthorized.status === 401, "wrong bearer token is rejected");
	const badOrigin = await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 6, method: "tools/list" }, { origin: "https://untrusted.example" });
	assert(badOrigin.status === 403, "untrusted Origin is rejected");
	const malformed = await post(bridge.url, bridge.token, "not-json");
	assert(malformed.status === 400, "malformed JSON is rejected");
	const oversized = await post(bridge.url, bridge.token, { jsonrpc: "2.0", id: 7, method: "tools/list", padding: "x".repeat(70_000) });
	assert(oversized.status === 413, "oversized request body is rejected");

	await bridge.close();
	const closed = await del(bridge.url, bridge.token).catch(() => 0);
	assert(closed === 0, "adapter closes its HTTP listener");

	const staleTestDone = (async () => {
		let resolveFirstStarted!: () => void;
		let resolveSecondStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
		const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });
		let invocation = 0;
		const callResolvers: Array<() => void> = [];
		const staleBridge = await startToolBridge({
			catalog,
			onToolCall: async () => {
				invocation += 1;
				if (invocation === 1) resolveFirstStarted();
				if (invocation === 2) resolveSecondStarted();
				await new Promise<void>((next) => { callResolvers.push(next); });
				return { content: [{ type: "text", text: "stale-safe" }] };
			},
		});
		const first = rawPost(staleBridge.url, staleBridge.token, {
			jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "probe_tool", arguments: {} },
		});
		await firstStarted;
		void first.response.catch(() => {});
		first.request.destroy();
		await wait(30);
		const second = post(staleBridge.url, staleBridge.token, {
			jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "probe_tool", arguments: {} },
		});
		await secondStarted;
		let secondSettled = false;
		void second.finally(() => { secondSettled = true; });
		callResolvers[0]?.();
		await wait(20);
		assert(!secondSettled, "an earlier disconnected response cannot reject a later call");
		callResolvers[1]?.();
		await second;
		await staleBridge.close();
	})();
	await staleTestDone;
	console.log("✓ stale disconnect cannot affect the next pending call");

	let pendingResolve: (() => void) | undefined;
	const pendingBridge = await startToolBridge({
		catalog,
		onToolCall: async () => {
			await new Promise<void>((resolve) => { pendingResolve = resolve; });
			return { content: [{ type: "text", text: "late" }] };
		},
	});
	const pendingRequest = post(pendingBridge.url, pendingBridge.token, {
		jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "probe_tool", arguments: {} },
	});
	await wait(20);
	await pendingBridge.close();
	await pendingRequest.catch(() => {});
	pendingResolve?.();
	console.log("✓ pending calls are cleaned up on close");
}

main().catch((error) => {
	console.error(`✗ tool bridge test failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
