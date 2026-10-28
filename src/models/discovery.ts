import { loadKiroAcpConfig, resolveAgentEngine } from '../config.ts';
import { configOptionChoices } from '../v3/config-options.ts';
import { DiscoveryClient } from './discovery-client.ts';
import { KIRO_MODELS, type KiroModelConfig } from './fallback.ts';
import { normalizeDiscoveredModel, dedupeModels } from './normalize.ts';

function abortError(): Error {
  const error = new Error('Kiro model discovery aborted');
  error.name = 'AbortError';
  return error;
}

export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The caller's request is already in flight; observe its late rejection so
    // aborting discovery does not surface as an unhandled rejection.
    void promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function discoverKiroModels(
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<KiroModelConfig[]> {
  const engine = resolveAgentEngine(loadKiroAcpConfig());
  const client = new DiscoveryClient(cwd, engine);
  try {
    if (signal?.aborted) throw abortError();
    await client.start();
    if (signal?.aborted) throw abortError();
    await abortable(
      client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'pi-kiro-acp-model-discovery', version: '1.0.0' },
        },
        30000,
      ),
      signal,
    );

    const session = (await abortable(
      client.request('session/new', { cwd, mcpServers: [] }, 30000),
      signal,
    )) as any;
    if (signal?.aborted) throw abortError();
    // V3 lists models as the `model` config option of the session; the shape
    // maps onto the same normalizer as v2's `models.availableModels`.
    const available =
      engine === 'v3'
        ? configOptionChoices(session?.configOptions, 'model').map(
            (choice) => ({ modelId: choice.value, name: choice.name }),
          )
        : session?.models?.availableModels;
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
