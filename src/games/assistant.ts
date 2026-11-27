import type { ModelCatalog } from '../models/catalog.js';
import type { ModelGateway } from '../agents/native/types.js';
import type { DesignAssistant } from './studio.js';

/**
 * Optional design narrative, routed exactly like every other model call.
 *
 * The model router resolves a verified zero-cost model, the daily budget is
 * checked and consumed, and the output is validated before it can reach a
 * project. A malformed answer, a paid-only route, an exhausted budget or an
 * aborted request all fall back to the deterministic plan. The assistant never
 * sees code generation or verification: those are deterministic and measured.
 */
export function createDesignAssistant(input: {
  models: ModelCatalog;
  gateway: ModelGateway | null;
  timeoutMs?: number;
}): DesignAssistant {
  const available = input.gateway !== null;

  return {
    available,
    narrate: async ({ ownerId, spec }) => {
      if (!input.gateway) return null;
      const resolved = input.models.resolve(null, 'cloud');
      if (!resolved.ok) return null;
      try {
        const completion = await input.gateway.complete({
          model: resolved.value.ref,
          ownerId, mode: 'cloud', operation: 'work',
          system:
            'You write short design narrative for a deterministic game generator. Reply with JSON only: {"logline": string, "pillars": string[]}. Never claim a mechanic that is not listed.',
          prompt: `Spec: ${JSON.stringify({
            prompt: spec.prompt,
            genre: spec.genre,
            camera: spec.camera,
            mechanics: spec.mechanics,
            levels: spec.levels,
            difficulty: spec.difficulty,
          })}`,
          signal: AbortSignal.timeout(input.timeoutMs ?? 20_000),
          maxOutputTokens: 320,
        });
        const parsed = JSON.parse(completion.text.trim()) as {
          logline?: unknown;
          pillars?: unknown;
        };
        const logline =
          typeof parsed.logline === 'string' && parsed.logline.length > 0
            ? parsed.logline.slice(0, 600)
            : undefined;
        const pillars = Array.isArray(parsed.pillars)
          ? parsed.pillars
              .filter((pillar): pillar is string => typeof pillar === 'string' && pillar.length > 0)
              .slice(0, 6)
              .map((pillar) => pillar.slice(0, 200))
          : undefined;
        if (!logline && (!pillars || pillars.length === 0)) return null;
        return {
          ...(logline ? { logline } : {}),
          ...(pillars && pillars.length > 0 ? { pillars } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}
