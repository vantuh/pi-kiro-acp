#!/usr/bin/env node
// MCP Bridge — relays tool calls between kiro-cli and pi's IPC server
// Usage: node kiro-acp-bridge.mjs --tools /path/to/tools.json

import { createInterface } from "node:readline";
import { readFileSync, watch } from "node:fs";
import { request } from "node:http";

function debugLog(...args) {
	process.stderr.write(
		"[mcp-bridge] " +
			args
				.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
				.join(" ") +
			"\n",
	);
}

let toolsPath = "";
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === "--tools") toolsPath = process.argv[++i] || "";
}
if (!toolsPath) {
	process.stderr.write("[mcp-bridge] Missing --tools\n");
	process.exit(1);
}

function loadToolsFile() {
	const raw = readFileSync(toolsPath, "utf-8");
	return JSON.parse(raw);
}

let state = loadToolsFile();

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function httpPost(port, path, body, secret) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const headers = {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(data),
		};
		if (secret) headers.Authorization = `Bearer ${secret}`;
		const req = request(
			{
				hostname: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers,
				timeout: 1800000,
			},
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString()));
					} catch {
						reject(new Error("Invalid JSON"));
					}
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("timeout"));
		});
		req.write(data);
		req.end();
	});
}

let callCounter = 0;

async function handleMessage(msg) {
	if (!("id" in msg)) return;

	switch (msg.method) {
		case "initialize":
			return send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "kiro-acp-bridge", version: "1.0.0" },
				},
			});

		case "tools/list":
			try {
				state = loadToolsFile();
			} catch {}
			debugLog("tools/list", (state.tools || []).length, "tools");
			return send({
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					tools: (state.tools || []).map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				},
			});

		case "tools/call": {
			const { name, arguments: args = {} } = msg.params || {};
			if (!state.ipcPort) {
				return send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						content: [{ type: "text", text: "IPC not configured" }],
						isError: true,
					},
				});
			}
			try {
				const callId = `bridge-${++callCounter}`;
				debugLog("tools/call", name, "callId:", callId);
				const result = await httpPost(
					state.ipcPort,
					"/tool/pending",
					{ callId, toolName: name, args },
					state.ipcSecret,
				);
				if (result.status === "success") {
					const content = result.content?.length
						? result.content
						: [{ type: "text", text: result.result || "" }];
					send({ jsonrpc: "2.0", id: msg.id, result: { content } });
				} else {
					send({
						jsonrpc: "2.0",
						id: msg.id,
						result: {
							content: [{ type: "text", text: result.error || "Error" }],
							isError: true,
						},
					});
				}
			} catch (err) {
				debugLog("tools/call error", name, err.message);
				send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						content: [{ type: "text", text: `Bridge error: ${err.message}` }],
						isError: true,
					},
				});
			}
			return;
		}

		case "ping":
			return send({ jsonrpc: "2.0", id: msg.id, result: {} });

		default:
			return send({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32601, message: `Unknown: ${msg.method}` },
			});
	}
}

try {
	let debounce = null;
	watch(toolsPath, () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => {
			try {
				state = loadToolsFile();
				send({
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
					params: {},
				});
			} catch {}
		}, 100);
	});
} catch {}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	try {
		handleMessage(JSON.parse(line.trim()));
	} catch {}
});
rl.on("close", () => process.exit(0));
