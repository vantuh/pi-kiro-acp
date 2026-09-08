#!/usr/bin/env node
// E2E live probe: verifies the kiro-acp transport assumptions against the
// REAL kiro-cli binary. Mirrors the extension's exact flow — `kiro-cli acp`
// spawn, JSON-RPC initialize, session/new|session/load with an HTTP MCP
// server — and inspects the model's actual tool list, the agent fallback
// path, NameCollision filtering and a real model-driven tools/call.
//
// GUARDED: requires KIRO_E2E_LIVE to run (it spawns kiro-cli and T5 spends a
// tiny amount of credits). It is NOT part of test/run-all.sh (not *.test.ts).
//
//   KIRO_E2E_LIVE=1     ./test/e2e/live.mjs   # free checks only (no model call)
//   KIRO_E2E_LIVE=full  ./test/e2e/live.mjs   # + T5 real model tools/call round-trip
//
// See test/e2e/README.md for what each check verifies and what failures mean.

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = process.env.KIRO_E2E_LIVE;
if (!GUARD) {
  console.error(
    "live probe spawns kiro-cli (and T5 spends credits).\n" +
      "Run with KIRO_E2E_LIVE=1 (free checks) or KIRO_E2E_LIVE=full (incl. T5 model call).",
  );
  process.exit(1);
}
const WITH_MODEL = GUARD === "full";

// ---------- isolated workspace ----------
const AGENT_DIR = mkdtempSync(join(tmpdir(), "kiro-e2e-"));
const GATE_CONFIG = join(AGENT_DIR, ".kiro", "agents", "test-gate.json");
const GATE_CONFIG_BODY = JSON.stringify(
  {
    name: "test-gate",
    tools: ["@pi_host"],
    allowedTools: ["@pi_host"],
    includeMcpJson: false,
    mcpServers: {},
    prompt: "You are a tool-calling probe. Follow the user instruction exactly.",
  },
  null,
  2,
);
const restoreGateConfig = () => {
  mkdirSync(join(AGENT_DIR, ".kiro", "agents"), { recursive: true });
  writeFileSync(GATE_CONFIG, GATE_CONFIG_BODY);
};
restoreGateConfig();

// ---------- mini MCP server (ephemeral port) ----------
let mcpToolCalls = 0;
const mcpTools = [
  {
    // collides with the Kiro builtin FsRead — drives the NameCollision check
    name: "read",
    description: "Reads a file. Call when the user asks to read a file.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    // no collision — proves non-colliding specs survive
    name: "pi_probe_tool",
    description: "Probe tool without a name collision.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    // the aliased form of the colliding `read` — must survive a fallback
    // NameCollision while plain `read` is dropped (aliasing defense)
    name: "pi_read",
    description: "Aliased probe tool; survives builtin name collisions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];
function startMcp() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (msg.method === "tools/call") mcpToolCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (msg.method === "initialize")
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mini", version: "0.0.1" } } }),
        );
      else if (msg.method === "tools/list")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: mcpTools } }));
      else if (msg.method === "tools/call")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "tool executed ok" }] } }));
      else if (msg.id !== undefined) res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      else res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => ok(server.address().port)),
  );
}
const mcpServer = (port) => ({
  type: "http",
  name: "pi_host",
  url: `http://127.0.0.1:${port}`,
  headers: [{ name: "Authorization", value: "Bearer x" }],
});

// ---------- kiro-cli ACP harness ----------
class Kiro {
  constructor(spawnArgs) {
    this.spawnArgs = spawnArgs;
    this.lines = [];
    this.verbose = []; // non-JSON stdout: kiro-cli's own -v logs (WARN/ERROR)
    this.notifications = [];
    this.permissionCount = 0;
    this.events = []; // tool_call / tool_call_update updates
    this.modelText = [];
  }
  start() {
    this.proc = spawn("kiro-cli", ["acp", ...this.spawnArgs, "-v"], {
      cwd: AGENT_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        this.lines.push(line);
        try {
          const msg = JSON.parse(line);
          if (msg.method) {
            this.notifications.push(msg);
            if (msg.method === "session/request_permission") {
              this.permissionCount++;
              // auto-allow so the probe never blocks; the count is the signal
              const allow =
                msg.params?.options?.find((o) => o.id === "allow_always")?.id ??
                "allow_once";
              this.send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { outcome: { outcome: "selected", optionId: allow } },
              });
            }
            if (msg.method === "session/update" || msg.method === "_kiro.dev/session/update") {
              const u = msg.params?.update ?? {};
              if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
                this.events.push({
                  kind: u.sessionUpdate,
                  tool: u._meta?.kiro?.toolName ?? u.title ?? null,
                  server: u._meta?.kiro?.mcpServerName ?? null,
                  status: u.status ?? null,
                });
              if (u.sessionUpdate === "agent_message_chunk" && u.content?.text)
                this.modelText.push(u.content.text);
            }
          }
        } catch {
          this.verbose.push(line.replace(/\x1b\[[0-9;]*m/g, ""));
        }
      }
    });
    this.proc.stderr.on("data", () => {});
  }
  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
  async rpc(method, params, timeoutMs = 45000) {
    const myId = Math.floor(Math.random() * 1e6) + 1;
    const start = this.lines.length;
    this.send({ jsonrpc: "2.0", id: myId, method, params });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = start; i < this.lines.length; i++) {
        try {
          const m = JSON.parse(this.lines[i]);
          if (m.id === myId) {
            if (m.error) throw new Error(`rpc ${method}: ${m.error.message}`);
            return m.result;
          }
        } catch (e) {
          if (e.message?.startsWith(`rpc ${method}`)) throw e;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout: ${method}`);
  }
  /** Wait until the tools list settles AND is informative (non-empty) — the
   * first notifications arrive before the MCP tools/list round-trip. */
  async latestTools(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const avail = [...this.notifications]
        .reverse()
        .find((n) => n.method === "_kiro.dev/commands/available");
      const tools = avail?.params?.tools;
      const snapshot = tools ? JSON.stringify(tools) : null;
      if (snapshot !== null && snapshot === last && tools.length > 0) return avail.params;
      last = snapshot;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  }
  async notFound() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const n = this.notifications.find((x) => x.method === "_kiro.dev/agent/not_found");
      if (n) return n.params;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  kill() {
    try {
      this.proc.kill("SIGKILL");
    } catch {}
  }
}

async function withKiro(spawnArgs, port, fn) {
  const k = new Kiro(spawnArgs);
  k.start();
  try {
    await k.rpc("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "kiro-acp-e2e", version: "1.0.0" },
    });
    return await fn(k);
  } finally {
    k.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

const summarizeTools = (params) => {
  if (!params?.tools) return null;
  const builtins = params.tools.filter((t) => t.source === "built-in").map((t) => t.name);
  const mcp = params.tools
    .filter((t) => String(t.source ?? "").startsWith("mcp:"))
    .map((t) => `${t.name}(${t.source})`);
  return { total: params.tools.length, builtins, mcp };
};

// ---------- checks ----------
const results = []; // { name, pass } — executed checks only
const skipped = []; // { name, why }
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`- SKIP ${name} — ${why}`);
};

const port = await startMcp();
const mcp = mcpServer(port);

// T1: fresh session under the gate config — zero builtins, pi_host tools only
await withKiro(["--agent", "test-gate", "--trust-tools", "@pi_host"], port, async (k) => {
  await k.rpc("session/new", { cwd: AGENT_DIR, mcpServers: [mcp] });
  const s = summarizeTools(await k.latestTools());
  check("T1a fresh session: zero built-in tools", s && s.builtins.length === 0, JSON.stringify(s));
  check(
    "T1b pi_host tools visible",
    s &&
      s.mcp.includes("read(mcp:pi_host)") &&
      s.mcp.includes("pi_probe_tool(mcp:pi_host)") &&
      s.mcp.includes("pi_read(mcp:pi_host)"),
    JSON.stringify(s),
  );
  check("T1c no NameCollision with gate config", !k.verbose.some((l) => l.includes("NameCollision")));
});

// T2 + T3: missing agent -> not_found fallback -> all builtins + NameCollision
await withKiro(["--agent", "no-such-agent-e2e", "--trust-all-tools"], port, async (k) => {
  await k.rpc("session/new", { cwd: AGENT_DIR, mcpServers: [mcp] });
  const nf = await k.notFound();
  check("T2a agent/not_found emitted", !!nf, JSON.stringify(nf));
  check("T2b fallback is kiro_default", nf?.fallbackAgent === "kiro_default", nf?.fallbackAgent ?? "none");
  const s = summarizeTools(await k.latestTools());
  check(
    "T2c fallback registers builtins",
    s && s.builtins.length >= 10,
    `${s?.builtins.length} builtins: ${s?.builtins.slice(0, 8).join(",")}…`,
  );
  let collision = null;
  const collisionDeadline = Date.now() + 10000;
  while (Date.now() < collisionDeadline) {
    collision = k.verbose.find((l) => l.includes("NameCollision"));
    if (collision) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check(
    "T3 NameCollision(BuiltIn(FsRead)) under fallback",
    !!collision && collision.includes("BuiltIn(FsRead)"),
    collision ? collision.slice(0, 100) : "no collision line in 10s",
  );
  const sAliased = summarizeTools(await k.latestTools());
  check(
    "T3b aliased pi_read survives the fallback collision",
    sAliased &&
      sAliased.mcp.includes("pi_read(mcp:pi_host)") &&
      !sAliased.mcp.includes("read(mcp:pi_host)"),
    JSON.stringify(sAliased),
  );
});

// T4-alt: restore across processes with the config still present — no leak
let gateSessionId = null;
await withKiro(["--agent", "test-gate", "--trust-tools", "@pi_host"], port, async (k) => {
  const sn = await k.rpc("session/new", { cwd: AGENT_DIR, mcpServers: [mcp] });
  gateSessionId = sn?.sessionId;
});
await withKiro(["--agent", "test-gate", "--trust-tools", "@pi_host"], port, async (k) => {
  try {
    await k.rpc("session/load", { sessionId: gateSessionId, cwd: AGENT_DIR, mcpServers: [mcp] });
  } catch (e) {
    check("T4-alt restore with config present: no leak", false, `session/load failed: ${e.message}`);
    return;
  }
  const s = summarizeTools(await k.latestTools());
  check("T4-alt restore with config present: no leak", s && s.builtins.length === 0, JSON.stringify(s));
});

// T4: the production leak mechanism — agent config DELETED before restore
// (the extension removes agent files on stop; a persisted session resumed
// later finds no config) -> agent fallback -> builtins leak into the model
unlinkSync(GATE_CONFIG);
try {
  await withKiro(["--agent", "test-gate", "--trust-tools", "@pi_host"], port, async (k) => {
    try {
      await k.rpc("session/load", { sessionId: gateSessionId, cwd: AGENT_DIR, mcpServers: [mcp] });
    } catch (e) {
      check("T4 restore with deleted config leaks builtins", false, `session/load failed: ${e.message}`);
      return;
    }
    const nf = await k.notFound();
    const s = summarizeTools(await k.latestTools());
    check(
      "T4 restore with deleted config leaks builtins",
      s && s.builtins.length > 0,
      `not_found=${JSON.stringify(nf)}; ${s?.builtins.length ?? "?"} builtins leaked: ${s?.builtins.slice(0, 8).join(",") || "none"}`,
    );
  });
} finally {
  restoreGateConfig();
}

// T5: real model-driven tools/call round-trip under the gate (spends credits)
if (WITH_MODEL) {
  await withKiro(["--agent", "test-gate", "--trust-tools", "@pi_host"], port, async (k) => {
    const sn = await k.rpc("session/new", { cwd: AGENT_DIR, mcpServers: [mcp] });
    await k.latestTools(); // ensure the model has the pi_host tools registered
    await k.rpc("session/prompt", {
      sessionId: sn.sessionId,
      prompt: [
        {
          type: "text",
          text: 'Call the read tool exactly once with arguments {"path": "notes.txt"}. Do not use any other tool. When it returns, reply with exactly: DONE',
        },
      ],
    }, 120000);
    check("T5a forwarded tool executed by the MCP host", mcpToolCalls >= 1, `${mcpToolCalls} tools/call(s) received; model: "${k.modelText.join("").trim().slice(0, 40)}"`);
    const piHostCalls = k.events.filter((e) => e.kind === "tool_call" && e.server === "pi_host");
    check("T5b tool_call tagged pi_host", piHostCalls.length >= 1, JSON.stringify(piHostCalls[0] ?? null));
    check("T5c zero permission RPCs for pi_host tools", k.permissionCount === 0, `${k.permissionCount} permission request(s)`);
  });
} else {
  skip("T5 model tools/call round-trip (a/b/c)", "run with KIRO_E2E_LIVE=full");
}

// ---------- cleanup + summary ----------
rmSync(AGENT_DIR, { recursive: true, force: true });

console.log("\n==== E2E SUMMARY ====");
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
for (const s of skipped) console.log(`SKIP   ${s.name} (${s.why})`);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    (skipped.length ? `, ${skipped.length} skipped` : ""),
);
process.exit(failed.length ? 1 : 0);
