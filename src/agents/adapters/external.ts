import type {
  AgentId,
  Availability,
  EngineCapabilities,
  EngineId,
} from '@coderax/contracts';
import type {
  AgentAdapter,
  AgentReport,
  AgentRunOutcome,
  AgentRunRequest,
} from '../types.js';

/**
 * The transport an external agent needs. It is injected, never imported: the
 * engine package does not depend on OpenCode or Freebuff to build or run, and a
 * deployment that wants one supplies its transport explicitly. Coderax Native is
 * unaffected by its absence.
 */
export type ExternalAgentTransport = {
  /** Bounded readiness probe; throw to report the engine unavailable. */
  probe: () => Promise<void>;
  run: (request: AgentRunRequest, report: AgentReport) => Promise<AgentRunOutcome>;
};

export type ExternalAdapterOptions = {
  agent: Extract<AgentId, 'opencode' | 'freebuff'>;
  engine: Extract<EngineId, 'opencode' | 'freebuff'>;
  label: string;
  enabled: boolean;
  transport: ExternalAgentTransport | null;
  /** Names the missing prerequisite, never a credential value. */
  missingDetail: string;
  capabilities: EngineCapabilities;
};

/**
 * External agents start disabled, receive no private memory, no credentials and
 * no conversations, and never replace Coderax Native. An explicitly selected but
 * unavailable external agent is reported as unavailable; the engine refuses the
 * task instead of substituting Native.
 */
export function createExternalAgentAdapter(options: ExternalAdapterOptions): AgentAdapter {
  let probed: Availability | null = null;

  function availability(): Availability {
    if (!options.enabled) {
      return {
        available: false,
        reason: 'disabled',
        detail: `${options.label} is optional and disabled.`,
      };
    }
    if (!options.transport) {
      return { available: false, reason: 'not_configured', detail: options.missingDetail };
    }
    if (probed) return probed;
    return {
      available: true,
      reason: 'ready',
      detail: `${options.label} is configured; readiness is verified on the first run.`,
    };
  }

  return {
    agent: options.agent,
    engine: options.engine,
    capabilities: options.capabilities,
    isolation: {
      workspace: 'isolated',
      memory: 'none',
      credentials: 'none',
      conversations: 'none',
    },
    availability,
    probe: async () => {
      if (!options.enabled) {
        return { ok: false, detail: `${options.label} is optional and disabled.` };
      }
      if (!options.transport) {
        return { ok: false, detail: options.missingDetail };
      }
      try {
        await options.transport.probe();
        probed = {
          available: true,
          reason: 'ready',
          detail: `${options.label} answered its readiness probe.`,
        };
        return { ok: true, detail: probed.detail };
      } catch {
        probed = {
          available: false,
          reason: 'server_unavailable',
          detail: `${options.label} did not answer its readiness probe.`,
        };
        return { ok: false, detail: probed.detail };
      }
    },
    run: async (request, report, admitDispatch) => {
      if (!options.enabled) {
        return {
          ok: false,
          code: 'disabled',
          detail: `${options.label} is optional and disabled.`,
          retryable: false,
        };
      }
      if (!options.transport) {
        return {
          ok: false,
          code: 'not_configured',
          detail: options.missingDetail,
          retryable: false,
        };
      }
      try {
        await options.transport.probe();
        probed = { available: true, reason: 'ready', detail: `${options.label} is ready.` };
      } catch {
        probed = {
          available: false,
          reason: 'server_unavailable',
          detail: `${options.label} did not answer its readiness probe.`,
        };
        return {
          ok: false,
          code: 'server_unavailable',
          detail: probed.detail,
          // Nothing was dispatched, so replaying on this engine is safe.
          retryable: true,
        };
      }
      if (request.signal.aborted) {
        return { ok: false, code: 'cancelled', detail: 'The run was cancelled.', retryable: false };
      }
      if (!admitDispatch?.()) {
        return {
          ok: false,
          code: 'not_configured',
          detail: 'External agent dispatch requires a current owner grant for this data mode.',
          retryable: false,
        };
      }
      return options.transport.run(request, report);
    },
  };
}
