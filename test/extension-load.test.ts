// Test: the extension loads and registers its provider (Risk 2 gate — a dangling
// import after cleanup would silently remove every kiro-acp model from pi).
// Run: test/run-all.sh test/extension-load.test.ts

import { KIRO_ACP_PROVIDER } from "../overflow.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

const events: string[] = [];
const providers: Array<{ id: string; config: any }> = [];
const commands: string[] = [];

const pi = {
  on(event: string, _handler: unknown) {
    events.push(event);
  },
  registerCommand(name: string, _options: unknown) {
    commands.push(name);
  },
  registerProvider(id: string, config: any) {
    providers.push({ id, config });
  },
} as any;

const register = (await import("../index.ts")).default;
assert(
  typeof register === "function",
  "index.ts exports a default registration function",
);

register(pi);

assert(
  providers.length === 1,
  "registration registers exactly one provider synchronously",
);
assert(providers[0].id === KIRO_ACP_PROVIDER, "the provider id is kiro-acp");

const config = providers[0].config;
assert(config.models.length > 0, "the provider ships fallback models");
assert(
  config.models.every((m: any) => typeof m.id === "string" && m.id),
  "every model has an id",
);
assert(
  typeof config.streamSimple === "function",
  "the provider exposes streamSimple",
);

for (const event of [
  "session_start",
  "turn_start",
  "message_start",
  "context",
  "message_end",
  "session_shutdown",
]) {
  assert(events.includes(event), `the extension subscribes to ${event}`);
}

assert(
  commands.includes("kiro-usage"),
  "the extension registers the kiro-usage command",
);

console.log("✓ all extension-load tests passed");
// Model discovery spawns kiro-cli in the background; nothing here waits on it.
process.exit(0);
