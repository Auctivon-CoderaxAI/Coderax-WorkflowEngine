import type { DataMode, ModelRef } from '@coderax/contracts';
import type { EmbeddingProvider } from '../knowledge/store.js';
import type { ModelRouter } from './router.js';

/**
 * The governed embedding boundary.
 *
 * Retrieval once built its own OpenAI-compatible client from an endpoint, a key
 * and a boolean config label, so document text could leave the process without
 * the router ever seeing the request: no verified price, no `embeddings` grant,
 * no mode check, no durable reservation and no usage record. This adapter has no
 * endpoint and no key. It holds the router, so every batch is resolved,
 * authorized, reserved and settled exactly like a completion.
 *
 * It deliberately exposes no way to relax that: there is no provider override, no
 * direct-dispatch branch and no local fallback. When the router refuses, the
 * batch throws and the store keeps lexical retrieval rather than presenting an
 * unembedded result as semantic.
 */
export function createRouterEmbeddings(input: {
  router: ModelRouter;
  ownerId: string;
  model: ModelRef;
}): EmbeddingProvider {
  const embed = input.router.embed;
  if (typeof embed !== 'function') {
    throw new Error('The model router does not implement governed embeddings.');
  }
  return {
    id: `router:${input.model.providerId}/${input.model.modelId}`,
    // A hosted embedding always transmits text to a provider, so it can never
    // serve private-mode documents. The store refuses before it is called.
    cloudOnly: true,
    embed: async (texts: string[], mode: DataMode) => {
      if (texts.length === 0) return [];
      const result = await embed({
        ownerId: input.ownerId,
        mode,
        texts,
        requested: input.model,
      });
      return result.vectors;
    },
  };
}
