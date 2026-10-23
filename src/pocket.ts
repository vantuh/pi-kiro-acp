import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

import { createKiroAcpProvider, KIRO_ACP_API } from './provider.ts';

/** Pocket 0.20's two public members, structural so this package needs no Pocket dependency. */
interface PocketHost {
  registerModelProvider?(provider: string, config: ProviderConfig): () => void;
}

interface PocketWeb {
  onDispose(dispose: () => unknown): void;
}

/** Pi's credential-check marker: kiro-cli owns sign-in, and authHeader: false keeps it out of requests. */
const AVAILABILITY_MARKER = 'kiro-cli-ambient';

/**
 * Registers the native Kiro ACP provider with Pocket. Call it from a drop-in
 * module's default export with `host` and `web`.
 */
export default function pocketAdapter(host: PocketHost, web: PocketWeb): void {
  if (typeof host.registerModelProvider !== 'function')
    throw new Error(
      'pi-kiro-acp needs Pi Pocket 0.20 or newer (host.registerModelProvider is missing)',
    );

  const provider = createKiroAcpProvider();
  let unregister: (() => void) | null = null;
  web.onDispose(async () => {
    unregister?.();
    await provider.close();
  });

  unregister = host.registerModelProvider(provider.id, {
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: KIRO_ACP_API,
    apiKey: AVAILABILITY_MARKER,
    authHeader: false,
    streamSimple: provider.streamSimple,
    models: [...provider.getModels()],
    // Pi calls this on every refresh; the copy keeps its catalog untouched.
    refreshModels: async (context) => {
      await provider.refreshModels?.(context);
      return [...provider.getModels()];
    },
  });
}
