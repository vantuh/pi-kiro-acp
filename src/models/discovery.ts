import { KIRO_MODELS, type KiroModelConfig } from "./fallback.ts";
import { normalizeDiscoveredModel, dedupeModels } from "./normalize.ts";
import { DiscoveryClient } from "./discovery-client.ts";

export async function discoverKiroModels(
  cwd = process.cwd(),
): Promise<KiroModelConfig[]> {
  const client = new DiscoveryClient(cwd);
  try {
    await client.start();
    await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "pi-kiro-acp-model-discovery", version: "1.0.0" },
      },
      30000,
    );

    const session = (await client.request(
      "session/new",
      { cwd, mcpServers: [] },
      30000,
    )) as any;
    const available = session?.models?.availableModels;
    if (!Array.isArray(available) || available.length === 0) return KIRO_MODELS;

    return dedupeModels(
      available
        .map(normalizeDiscoveredModel)
        .filter(Boolean) as KiroModelConfig[],
    );
  } finally {
    await client.stop();
  }
}
