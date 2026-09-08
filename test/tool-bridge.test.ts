// Test: authenticated loopback Streamable HTTP MCP adapter.
// Run: test/run-all.sh test/tool-bridge.test.ts

import { buildForwardedToolCatalog } from "../tool-catalog.ts";
import { startToolBridge } from "../tool-bridge.ts";
import {
  assert,
  del,
  post,
  rawPost,
  sseMessages,
  ssePost,
  wait,
  type HttpResponse,
} from "./support.ts";

const catalog = buildForwardedToolCatalog(
  [
    {
      name: "probe_tool",
      description: "A probe tool",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      sourceInfo: { source: "package" },
    },
  ],
  ["probe_tool"],
);


async function main(): Promise<void> {
  let resolveCall: (() => void) | undefined;
  let callStarted: ((call: any) => void) | undefined;
  const bridge = await startToolBridge({
    catalog,
    onToolCall: async (call) => {
      callStarted?.(call);
      await new Promise<void>((resolve) => {
        resolveCall = resolve;
      });
      return {
        content: [{ type: "text", text: JSON.stringify(call.arguments) }],
      };
    },
  });
  assert(
    bridge.url.startsWith("http://127.0.0.1:"),
    "adapter binds to loopback",
  );
  assert(bridge.token.length >= 64, "adapter token has sufficient entropy");

  const initialized = await post(
    bridge.url,
    bridge.token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    { accept: "application/json, text/event-stream" },
  );
  assert(initialized.status === 200, "initialize returns HTTP 200");
  assert(
    initialized.body.result?.capabilities?.tools,
    "initialize advertises tools capability",
  );

  const notification = await post(bridge.url, bridge.token, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert(
    notification.status === 202 && notification.body === undefined,
    "initialized notification returns 202 without a body",
  );

  const listed = await post(bridge.url, bridge.token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  assert(
    listed.body.result?.tools?.[0]?.name === "probe_tool",
    "tools/list returns the current catalog",
  );
  assert(
    listed.body.result?.tools?.[0]?.inputSchema === undefined ||
      listed.body.result.tools[0].inputSchema.type === "object",
    "tools/list returns inputSchema",
  );

  let received: any;
  const started = new Promise<void>((resolve) => {
    callStarted = (call) => {
      received = call;
      resolve();
    };
  });
  const callPromise = post(bridge.url, bridge.token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "probe_tool", arguments: { value: "ok" } },
  });
  await started;
  await wait(20);
  let settled = false;
  void callPromise.finally(() => {
    settled = true;
  });
  await wait(20);
  assert(!settled, "tools/call remains pending until Pi resolves it");
  assert(
    received?.piName === "probe_tool" && received.arguments.value === "ok",
    "tools/call maps alias and arguments",
  );
  resolveCall!();
  const called = await callPromise;
  assert(
    called.body.result?.content?.[0]?.text === '{"value":"ok"}',
    "successful tool result returns MCP content",
  );

  const unknown = await post(bridge.url, bridge.token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "missing_tool", arguments: {} },
  });
  assert(
    unknown.body.error?.code === -32602,
    "unknown tool is rejected before Pi execution",
  );

  const unauthorized = await post(bridge.url, "wrong-token", {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
  });
  assert(unauthorized.status === 401, "wrong bearer token is rejected");
  const badOrigin = await post(
    bridge.url,
    bridge.token,
    { jsonrpc: "2.0", id: 6, method: "tools/list" },
    { origin: "https://untrusted.example" },
  );
  assert(badOrigin.status === 403, "untrusted Origin is rejected");
  const malformed = await post(bridge.url, bridge.token, "not-json");
  assert(malformed.status === 400, "malformed JSON is rejected");
  const oversized = await post(bridge.url, bridge.token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
    padding: "x".repeat(70_000),
  });
  assert(oversized.status === 413, "oversized request body is rejected");

  await bridge.close();
  const closed = await del(bridge.url, bridge.token).catch(() => 0);
  assert(closed === 0, "adapter closes its HTTP listener");

  const staleTestDone = (async () => {
    let resolveFirstStarted!: () => void;
    let resolveSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecondStarted = resolve;
    });
    let invocation = 0;
    const callResolvers: Array<() => void> = [];
    const staleBridge = await startToolBridge({
      catalog,
      onToolCall: async () => {
        invocation += 1;
        if (invocation === 1) resolveFirstStarted();
        if (invocation === 2) resolveSecondStarted();
        await new Promise<void>((next) => {
          callResolvers.push(next);
        });
        return { content: [{ type: "text", text: "stale-safe" }] };
      },
    });
    const first = rawPost(staleBridge.url, staleBridge.token, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "probe_tool", arguments: {} },
    });
    await firstStarted;
    void first.response.catch(() => {});
    first.request.destroy();
    await wait(30);
    const second = post(staleBridge.url, staleBridge.token, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "probe_tool", arguments: {} },
    });
    await secondStarted;
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    callResolvers[0]?.();
    await wait(20);
    assert(
      !secondSettled,
      "an earlier disconnected response cannot reject a later call",
    );
    callResolvers[1]?.();
    await second;
    await staleBridge.close();
  })();
  await staleTestDone;
  console.log("✓ stale disconnect cannot affect the next pending call");

  // Kiro issues overlapping pi_host POSTs in one turn (two probe_tool, or
  // probe_tool + web_search). A single-slot pending rejected the second with
  // -32000 and the model reported a transport error.
  {
    const resolvers = new Map<string, () => void>();
    const started = new Map<string, Promise<void>>();
    const markStarted = new Map<string, () => void>();
    for (const value of ["alpha", "beta"]) {
      started.set(
        value,
        new Promise<void>((resolve) => markStarted.set(value, resolve)),
      );
    }
    const parallelBridge = await startToolBridge({
      catalog,
      onToolCall: async (call) => {
        const value = String(
          (call.arguments as { value?: unknown }).value ?? "",
        );
        markStarted.get(value)?.();
        await new Promise<void>((resolve) => resolvers.set(value, resolve));
        return { content: [{ type: "text", text: value }] };
      },
    });
    const alphaPromise = post(parallelBridge.url, parallelBridge.token, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "probe_tool", arguments: { value: "alpha" } },
    });
    const betaPromise = post(parallelBridge.url, parallelBridge.token, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "probe_tool", arguments: { value: "beta" } },
    });
    let bothStarted = false;
    await Promise.race([
      Promise.all([started.get("alpha"), started.get("beta")]).then(() => {
        bothStarted = true;
      }),
      wait(200).then(() => {
        if (!bothStarted)
          throw new Error(
            "overlapping second call did not start (still single-slot pending?)",
          );
      }),
    ]);
    let alphaSettled = false;
    let betaSettled = false;
    void alphaPromise.finally(() => {
      alphaSettled = true;
    });
    void betaPromise.finally(() => {
      betaSettled = true;
    });
    await wait(20);
    assert(
      !alphaSettled && !betaSettled,
      "overlapping tools/call both stay pending",
    );

    resolvers.get("beta")?.();
    const beta = await betaPromise;
    await wait(20);
    assert(
      beta.body.error === undefined,
      "the second in-flight call is not rejected as already-pending",
    );
    assert(
      beta.body.result?.content?.[0]?.text === "beta",
      "the second call returns its own result",
    );
    assert(
      !alphaSettled,
      "finishing one overlapping call leaves the other pending",
    );

    resolvers.get("alpha")?.();
    const alpha = await alphaPromise;
    assert(
      alpha.body.result?.content?.[0]?.text === "alpha",
      "the first call still returns its own result",
    );
    await parallelBridge.close();
  }

  {
    const resolvers: Array<() => void> = [];
    let markBothStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let invocations = 0;
    const overlapBridge = await startToolBridge({
      catalog,
      onToolCall: async () => {
        invocations += 1;
        if (invocations === 2) markBothStarted();
        await new Promise<void>((next) => resolvers.push(next));
        return { content: [{ type: "text", text: "kept" }] };
      },
    });
    const first = rawPost(overlapBridge.url, overlapBridge.token, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "probe_tool", arguments: { value: "drop" } },
    });
    const second = post(overlapBridge.url, overlapBridge.token, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "probe_tool", arguments: { value: "keep" } },
    });
    let overlapStarted = false;
    await Promise.race([
      bothStarted.then(() => {
        overlapStarted = true;
      }),
      wait(200).then(() => {
        if (!overlapStarted)
          throw new Error(
            "overlapping second call did not start (still single-slot pending?)",
          );
      }),
    ]);
    void first.response.catch(() => {});
    first.request.destroy();
    await wait(30);
    let secondSettled = false;
    void second.finally(() => {
      secondSettled = true;
    });
    await wait(20);
    assert(
      !secondSettled,
      "disconnecting one overlapping call does not settle the other",
    );
    resolvers[1]?.();
    const kept = await second;
    assert(
      kept.body.result?.content?.[0]?.text === "kept",
      "the surviving overlapping call still returns",
    );
    resolvers[0]?.();
    await overlapBridge.close();
  }

  let pendingResolve: (() => void) | undefined;
  const pendingBridge = await startToolBridge({
    catalog,
    onToolCall: async () => {
      await new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
      return { content: [{ type: "text", text: "late" }] };
    },
  });
  const pendingRequest = post(pendingBridge.url, pendingBridge.token, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "probe_tool", arguments: {} },
  });
  await wait(20);
  await pendingBridge.close();
  await pendingRequest.catch(() => {});
  pendingResolve?.();
  console.log("✓ pending calls are cleaned up on close");

  // A slow pi tool (subagent, deep research) produces no bytes for minutes.
  // Kiro's MCP client abandons such a request, silently losing the result, so
  // SSE clients get keepalives until the tool actually finishes.
  {
    let finishSlowCall: (() => void) | undefined;
    const debug: string[] = [];
    const slowBridge = await startToolBridge({
      catalog,
      keepaliveMs: 25,
      onDebug: (message) => debug.push(message),
      onToolCall: async () => {
        await new Promise<void>((resolve) => {
          finishSlowCall = resolve;
        });
        return { content: [{ type: "text", text: "slow-done" }] };
      },
    });

    const stream = ssePost(slowBridge.url, slowBridge.token, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "probe_tool",
        arguments: {},
        _meta: { progressToken: "p-1" },
      },
    });
    const headers = await stream.headers;
    assert(
      String(headers["content-type"]).startsWith("text/event-stream"),
      "an SSE client gets a streamed response",
    );
    assert(
      headers["content-length"] === undefined,
      "a streamed response is not length-delimited",
    );

    await wait(90);
    const midCall = stream.chunks.join("");
    assert(
      midCall.includes(": keepalive"),
      "a still-running tool call is kept warm with SSE comments",
    );
    const progressMessages = sseMessages(midCall).filter(
      (m) => m.method === "notifications/progress",
    );
    assert(
      progressMessages.length > 0,
      "a progressToken yields MCP progress notifications",
    );
    assert(
      progressMessages[0].params.progressToken === "p-1",
      "progress notifications echo the client's token",
    );
    assert(
      progressMessages.every(
        (m, i) =>
          i === 0 ||
          m.params.progress > progressMessages[i - 1].params.progress,
      ),
      "progress values increase",
    );
    assert(
      !midCall.includes('"result"'),
      "the result is not sent before the tool finishes",
    );

    finishSlowCall!();
    const body = await stream.done;
    const results = sseMessages(body).filter((m) => m.id === 11);
    assert(
      results.length === 1,
      "the response is delivered exactly once on the stream",
    );
    assert(
      results[0].result?.content?.[0]?.text === "slow-done",
      "the tool result closes the stream",
    );
    assert(
      debug.includes("bridge tools/call accepted"),
      "the transport reports call setup to the debug sink",
    );
    await slowBridge.close();
  }

  // Kiro 2.5.0 sends no Accept header; that path must stay plain JSON.
  {
    const jsonBridge = await startToolBridge({
      catalog,
      keepaliveMs: 25,
      onToolCall: async () => ({ content: [{ type: "text", text: "plain" }] }),
    });
    const plain = await post(jsonBridge.url, jsonBridge.token, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "probe_tool", arguments: {} },
    });
    assert(
      plain.status === 200 && plain.body.result?.content?.[0]?.text === "plain",
      "a non-SSE client still gets a JSON response",
    );
    await jsonBridge.close();
  }
}

main().catch((error) => {
  console.error(
    `✗ tool bridge test failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
