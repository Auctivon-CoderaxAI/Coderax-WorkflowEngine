import type { AgentId, AgentList } from '@coderax/contracts';
import type { AgentAdapter } from './types.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Agent discovery and selection.
 *
 * `resolve` maps an explicit agent id to exactly one adapter. An omitted id means
 * the default agent (Coderax Native). A disabled, unconfigured or unavailable
 * agent returns a typed failure; it is never replaced by another agent, because a
 * silent substitution would run different code, on different data, than the owner
 * asked for.
 */
export type AgentRegistry = {
  list: () => AgentList;
  get: (agent: AgentId) => AgentAdapter | null;
  resolve: (agent?: AgentId | null) => ServiceResult<AgentAdapter>;
  defaultAgent: AgentId;
};

export function createAgentRegistry(input: {
  adapters: AgentAdapter[];
  defaultAgent: AgentId;
}): AgentRegistry {
  const byId = new Map(input.adapters.map((adapter) => [adapter.agent, adapter]));

  return {
    defaultAgent: input.defaultAgent,
    list: () => ({
      agents: input.adapters.map((adapter) => ({
        id: adapter.agent,
        engine: adapter.engine,
        label:
          adapter.agent === 'coderax'
            ? 'Coderax Native'
            : adapter.agent === 'opencode'
              ? 'OpenCode Agent'
              : 'FreeBuff Agent',
        external: adapter.agent !== 'coderax',
        capabilities: adapter.capabilities,
        availability: adapter.availability(),
        isolation: adapter.isolation,
      })),
    }),
    get: (agent) => byId.get(agent) ?? null,
    resolve: (agent) => {
      const id = agent ?? input.defaultAgent;
      const adapter = byId.get(id);
      if (!adapter) {
        return fail('engine_unavailable', `The ${id} agent is not registered.`);
      }
      const availability = adapter.availability();
      if (!availability.available) {
        const code =
          availability.reason === 'disabled'
            ? 'engine_unavailable'
            : availability.reason === 'not_configured'
              ? 'engine_not_configured'
              : 'engine_unavailable';
        return fail(code, availability.detail);
      }
      return ok(adapter);
    },
  };
}
