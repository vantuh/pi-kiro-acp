// Test: deny Kiro builtins, allow only pi_host / forwarded / pi_* tools.
// Run: test/run-all.sh test/permissions.test.ts

import {
  isPiHostPermission,
  kiroToolNameFromPermissionParams,
  mcpServerFromPermissionParams,
  pickPermissionOptionId,
} from "../permissions.ts";

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

{
  const params = {
    toolCall: {
      _meta: { kiro: { mcpServerName: "pi_host", toolName: "bash" } },
    },
  };
  assert(mcpServerFromPermissionParams(params) === "pi_host", "reads mcpServer");
  assert(kiroToolNameFromPermissionParams(params) === "bash", "reads toolName");
  assert(
    isPiHostPermission(params, []),
    "pi_host is allowed even with empty catalog",
  );
}

{
  assert(
    !isPiHostPermission(
      { toolCall: { toolName: "subagent" } },
      ["pi_subagent"],
    ),
    "native subagent is denied even if pi_subagent is forwarded",
  );
  assert(
    isPiHostPermission({ toolCall: { toolName: "pi_subagent" } }, []),
    "aliased pi_subagent is allowed",
  );
  assert(
    isPiHostPermission({ toolCall: { toolName: "bash" } }, ["bash"]),
    "forwarded bash (not a Kiro builtin name) is allowed",
  );
  assert(
    !isPiHostPermission({ options: [{ id: "allow_always" }] }, ["bash"]),
    "unidentified permission is denied",
  );
}

{
  const opts = [{ id: "reject_once" }, { id: "allow_always" }];
  assert(
    pickPermissionOptionId(opts, true) === "allow_always",
    "allow prefers allow_always",
  );
  assert(
    pickPermissionOptionId(opts, false) === "reject_once",
    "deny prefers reject_once when reject_always is missing",
  );
  assert(
    pickPermissionOptionId([{ id: "allow_once" }], false) === null,
    "deny with no reject option returns null (caller cancels)",
  );
}

console.log("✓ all permission tests passed");
