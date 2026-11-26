import type { AgentAdapter } from './types.js';

/**
 * Live readiness.
 *
 * `availability()` answers "is this agent admitted by configuration". It cannot
 * answer "can it run right now", because that needs a request to the agent. This
 * probe asks every agent that configuration admits, with a bound: a hung
 * provider degrades the health report instead of hanging it.
 *
 * It is deliberately not part of startup. An external agent being down must not
 * stop an engine that still has Coderax Native, so the composition root registers
 * this as a non-required check.
 */

export type AgentProbeResult = { ok: boolean; detail: string };

export type AgentProbeReport = {
  status: 'ok' | 'failed';
  detail: string;
};

async function probeOne(adapter: AgentAdapter, timeoutMs: number): Promise<AgentProbeResult> {
  const probe = adapter.probe;
  if (!probe) return { ok: false, detail: 'No readiness probe is exposed.' };

  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      probe(),
      new Promise<AgentProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, detail: 'The readiness probe did not answer in time.' }),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } catch {
    return { ok: false, detail: 'The readiness probe failed.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeAgents(input: {
  adapters: AgentAdapter[];
  timeoutMs: number;
}): Promise<AgentProbeReport> {
  const admitted = input.adapters.filter((adapter) => adapter.availability().available);
  if (admitted.length === 0) {
    return { status: 'failed', detail: 'No agent is available to probe.' };
  }

  const results = await Promise.all(
    admitted.map(async (adapter) => ({
      agent: adapter.agent,
      ...(await probeOne(adapter, input.timeoutMs)),
    })),
  );
  const failed = results.filter((entry) => !entry.ok);
  if (failed.length === 0) {
    return {
      status: 'ok',
      detail: `${results.length} available agent(s) answered their readiness probe.`,
    };
  }
  return {
    status: 'failed',
    detail: failed.map((entry) => `${entry.agent}: ${entry.detail}`).join('; '),
  };
}
