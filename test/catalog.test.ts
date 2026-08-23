// Test: active extension-tool catalog filtering, aliases, and fingerprints.
// Run: jiti test/catalog.test.ts

import { createHash } from "node:crypto";
import { buildForwardedToolCatalog, isKiroToolName } from "../tool-catalog.ts";

function assert(condition: unknown, label: string): void {
	if (!condition) {
		console.error(`✗ ${label}`);
		process.exit(1);
	}
	console.log(`✓ ${label}`);
}

const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
const extension = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	description: `${name} description`,
	parameters: schema,
	sourceInfo: { source: "package" },
	...extra,
});

{
	const catalog = buildForwardedToolCatalog(
		[
			extension("active_tool"),
			extension("inactive_tool"),
			extension("builtin_tool", { sourceInfo: { source: "builtin" } }),
			extension("sdk_tool", { sourceInfo: { source: "sdk" } }),
		],
		["active_tool", "builtin_tool", "sdk_tool"],
	);
	assert(catalog.tools.length === 1, "only active extension tools are exposed");
	assert(catalog.tools[0]?.piName === "active_tool", "active tool keeps original Pi name");
	assert(catalog.tools[0]?.parameters === schema, "TypeBox/JSON schema is preserved");
}

{
	const catalog = buildForwardedToolCatalog([], []);
	assert(catalog.tools.length === 0, "empty active set produces an empty catalog");
	assert(catalog.fingerprint.length === 64, "empty catalog has a SHA-256 fingerprint");
}

{
	const catalog = buildForwardedToolCatalog([
		{ name: "missing_description", parameters: undefined, sourceInfo: { source: "package" } },
	], ["missing_description"]);
	assert(catalog.tools[0]?.description.includes("Host Pi extension tool"), "missing description gets a safe fallback");
	assert(catalog.tools[0]?.parameters.type === "object", "missing schema gets an empty object schema");
	assert(catalog.diagnostics.length === 2, "fallbacks emit concise diagnostics");

	const paddedDescription = "  preserve this spacing  ";
	const padded = buildForwardedToolCatalog([
		extension("padded_description", { description: paddedDescription }),
	], ["padded_description"]);
	assert(padded.tools[0]?.description === paddedDescription, "non-empty descriptions are preserved verbatim");
}

{
	const invalidName = "tool.with.dot";
	const first = buildForwardedToolCatalog([extension(invalidName), extension("valid_tool")], [invalidName, "valid_tool"]);
	const reordered = buildForwardedToolCatalog([extension("valid_tool"), extension(invalidName)], ["valid_tool", invalidName]);
	const aliased = first.tools.find((tool) => tool.piName === invalidName);
	assert(aliased && aliased.kiroName !== invalidName, "incompatible name receives an alias");
	assert(isKiroToolName(aliased!.kiroName), "generated alias satisfies Kiro name constraints");
	assert(aliased!.kiroName === reordered.tools.find((tool) => tool.piName === invalidName)?.kiroName, "aliases are input-order independent");
	assert(first.fingerprint === reordered.fingerprint, "fingerprint is input-order independent");
}

{
	const invalidName = "collision.name";
	const hash = createHash("sha256").update(invalidName).digest("hex");
	const validCollision = `pi_${hash.slice(0, 16)}`;
	const catalog = buildForwardedToolCatalog([extension(invalidName), extension(validCollision)], [invalidName, validCollision]);
	const invalid = catalog.tools.find((tool) => tool.piName === invalidName);
	assert(catalog.tools.length === 2, "alias collision does not drop either resolvable tool");
	assert(catalog.tools.find((tool) => tool.piName === validCollision)?.kiroName === validCollision, "valid name wins alias collision");
	assert(invalid?.kiroName !== validCollision && invalid?.kiroName.length === 23, "collision gets a deterministic extended alias");
	assert(catalog.piNameByKiroName.get(invalid!.kiroName) === invalidName, "alias maps unambiguously to the Pi name");
}

{
	const peerSendSchema = {
		anyOf: [
			{ type: "object", properties: { role: { type: "string" }, content: { type: "string" } }, required: ["role", "content"] },
			{ type: "object", properties: { agent: { type: "string" }, message: { type: "string" } }, required: ["agent", "message"] },
		],
	};
	const catalog = buildForwardedToolCatalog([extension("peer_send", { parameters: peerSendSchema })], ["peer_send"]);
	assert(JSON.stringify(catalog.tools[0]?.parameters) === JSON.stringify(peerSendSchema), "peer_send union schema survives unchanged");
}

{
	const base = buildForwardedToolCatalog([extension("fingerprint_tool")], ["fingerprint_tool"]);
	const changedDescription = buildForwardedToolCatalog([extension("fingerprint_tool", { description: "changed" })], ["fingerprint_tool"]);
	const changedSchema = buildForwardedToolCatalog([extension("fingerprint_tool", { parameters: { type: "object", properties: {} } })], ["fingerprint_tool"]);
	const changedName = buildForwardedToolCatalog([extension("other_tool")], ["other_tool"]);
	assert(base.fingerprint !== changedDescription.fingerprint, "description changes fingerprint");
	assert(base.fingerprint !== changedSchema.fingerprint, "schema changes fingerprint");
	assert(base.fingerprint !== changedName.fingerprint, "name changes fingerprint");
}

console.log("✓ all catalog tests passed");
process.exit(0);
