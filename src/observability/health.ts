import type {
  CheckStatus,
  EngineStatus,
  HealthCheck,
  HealthReport,
  ReadinessReport,
} from '@coderax/contracts';
import { V1_HEALTH_VERSION } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';

export type HealthProbe = {
  name: string;
  required: boolean;
  check: () => Promise<{ status: CheckStatus; detail?: string }>;
};

/**
 * Readiness is narrower than health on purpose: an engine that is listening but
 * has not validated its configuration, dependencies and storage must not accept
 * traffic. `verifyStartup` is the gate, and its failures name what is missing.
 */
export type HealthService = {
  verifyStartup: () => Promise<string[]>;
  markReady: () => void;
  report: () => Promise<HealthReport>;
  readiness: () => Promise<ReadinessReport>;
  check: () => Promise<HealthCheck[]>;
};

export function createHealthService(input: {
  clock: Clock;
  probes: HealthProbe[];
  engines: () => EngineStatus[];
}): HealthService {
  const startedAt = input.clock.iso();
  const startedMs = input.clock.now().getTime();
  let ready = false;

  async function check(): Promise<HealthCheck[]> {
    return Promise.all(
      input.probes.map(async (probe) => {
        try {
          const result = await probe.check();
          return {
            name: probe.name,
            status: result.status,
            required: probe.required,
            ...(result.detail ? { detail: result.detail } : {}),
          };
        } catch {
          return {
            name: probe.name,
            status: 'failed' as const,
            required: probe.required,
            detail: `${probe.name} could not be verified.`,
          };
        }
      }),
    );
  }

  function overall(checks: HealthCheck[]): CheckStatus {
    if (checks.some((entry) => entry.required && entry.status !== 'ok')) return 'failed';
    if (checks.some((entry) => entry.status !== 'ok')) return 'degraded';
    return 'ok';
  }

  return {
    verifyStartup: async () => {
      const checks = await check();
      return checks
        .filter((entry) => entry.required && entry.status !== 'ok')
        .map((entry) => `${entry.name}: ${entry.detail ?? entry.status}`);
    },
    markReady: () => {
      ready = true;
    },
    check,
    report: async () => {
      const checks = await check();
      return {
        status: overall(checks),
        contractVersion: V1_HEALTH_VERSION,
        startedAt,
        uptimeMs: Math.max(0, input.clock.now().getTime() - startedMs),
        checks,
        engines: input.engines(),
      };
    },
    readiness: async () => {
      const checks = await check();
      const missing = checks
        .filter((entry) => entry.required && entry.status !== 'ok')
        .map((entry) => entry.name);
      return {
        ready: ready && missing.length === 0,
        missing,
        checks,
      };
    },
  };
}
