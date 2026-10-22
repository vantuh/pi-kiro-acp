import {
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';

import { createOutputMessage } from './helpers.ts';
import { discoverKiroModels } from './models/discovery.ts';
import { KIRO_MODELS, type KiroModelConfig } from './models/fallback.ts';
import { KIRO_ACP_PROVIDER, tagKiroContextOverflow } from './overflow.ts';
import { SessionManager, type KiroStreamOptions } from './session-manager.ts';
import { streamKiroAcp } from './stream.ts';

export const KIRO_ACP_API = 'kiro-acp-api';

export type SessionManagerResolver = (sessionId?: string) => SessionManager;

export interface KiroAcpProviderOptions {
  /** Initial catalog. Defaults to the built-in fallback list. */
  models?: readonly KiroModelConfig[];
  /** Host routing. Standalone Models use omits it and gets the owned manager. */
  resolveSessionManager?: SessionManagerResolver;
}

export interface KiroAcpProvider extends Provider<Api> {
  /** The manager this provider owns; the host adapter registers it per session. */
  readonly sessionManager: SessionManager;
  close(): Promise<void>;
}

function toModel(config: KiroModelConfig): Model<Api> {
  return {
    ...config,
    api: KIRO_ACP_API,
    provider: KIRO_ACP_PROVIDER,
    baseUrl: 'local',
  } as Model<Api>;
}

function errorStream(
  model: Model<Api>,
  message: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = createOutputMessage(model);
  output.stopReason = 'error';
  output.errorMessage = tagKiroContextOverflow(message);
  stream.push({ type: 'error', reason: 'error', error: output });
  stream.end();
  return stream;
}

/**
 * Native pi-ai provider backed by an owned Kiro ACP runtime.
 *
 * Ambient auth: kiro-cli keeps its own credentials, so no API key or login flow
 * exists here. `resolve` reports the provider as configured and the CLI reports
 * authentication failures at stream time.
 */
export function createKiroAcpProvider(
  options: KiroAcpProviderOptions = {},
): KiroAcpProvider {
  const sessionManager = new SessionManager();
  const resolveSessionManager =
    options.resolveSessionManager ?? (() => sessionManager);
  const closeController = new AbortController();
  let models = (options.models ?? KIRO_MODELS).map(toModel);
  let closing = false;
  let closePromise: Promise<void> | null = null;
  const activeDiscoveries = new Set<Promise<void>>();

  const stream = (
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: KiroStreamOptions,
  ): AssistantMessageEventStream => {
    if (closing) return errorStream(model, 'Kiro ACP provider is closed');
    let routed: SessionManager;
    try {
      routed = resolveSessionManager(streamOptions?.sessionId);
    } catch (error) {
      return errorStream(
        model,
        error instanceof Error ? error.message : String(error),
      );
    }
    return streamKiroAcp(routed, model, context, streamOptions);
  };

  return {
    id: KIRO_ACP_PROVIDER,
    name: 'Kiro ACP',
    baseUrl: 'local',
    auth: {
      apiKey: {
        name: 'kiro-cli',
        resolve: async () => ({ auth: {}, source: 'kiro-cli' }),
      },
    },
    getModels: () => models,
    refreshModels: async (context: RefreshModelsContext) => {
      if (closing || !context.allowNetwork) return;
      const signal = AbortSignal.any([context.signal, closeController.signal]);
      if (signal.aborted) return;
      const discovery = (async () => {
        const discovered = await discoverKiroModels(process.cwd(), signal);
        if (closing || signal.aborted) return;
        await context.publish({
          update: () => {
            if (closing) return;
            models = discovered.map(toModel);
          },
        });
      })();
      activeDiscoveries.add(discovery);
      try {
        await discovery;
      } finally {
        activeDiscoveries.delete(discovery);
      }
    },
    stream: (
      model: Model<Api>,
      context: TranscriptContext,
      opts?: StreamOptions,
    ) => stream(model, context, opts),
    streamSimple: (
      model: Model<Api>,
      context: TranscriptContext,
      opts?: SimpleStreamOptions,
    ) => stream(model, context, opts),
    sessionManager,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closeController.abort();
      closePromise = (async () => {
        await Promise.allSettled([...activeDiscoveries]);
        await sessionManager.close();
      })();
      return closePromise;
    },
  };
}
