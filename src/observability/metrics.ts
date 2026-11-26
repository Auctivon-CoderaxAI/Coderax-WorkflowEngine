import type { Clock } from '../support/clock.js';

/**
 * Small, honest process counters.
 *
 * The engine does not ship a metrics client or a background exporter: $0 and no
 * extra daemon. The HTTP metrics route and the structured request log read this
 * registry, so an operator can scrape one process without a second service, and
 * a test can assert the counters without a metrics backend.
 */
export type RequestCounters = {
  total: number;
  active: number;
  succeeded: number;
  rejected: number;
  failed: number;
};

export type LeaseCounters = {
  renewFailed: number;
  renewError: number;
  fencingFailed: number;
};

export type MetricsRegistry = {
  readonly startedAt: string;
  requestStarted: () => void;
  requestFinished: (status: number) => void;
  recordLeaseFailure: (kind: keyof LeaseCounters) => void;
  counters: () => { requests: RequestCounters; leases: LeaseCounters };
  uptimeMs: () => number;
};

export function createMetricsRegistry(input: { clock: Clock }): MetricsRegistry {
  const startedAt = input.clock.iso();
  const startedMs = input.clock.now().getTime();
  const requests: RequestCounters = {
    total: 0,
    active: 0,
    succeeded: 0,
    rejected: 0,
    failed: 0,
  };
  const leases: LeaseCounters = {
    renewFailed: 0,
    renewError: 0,
    fencingFailed: 0,
  };

  return {
    startedAt,
    requestStarted: () => {
      requests.total += 1;
      requests.active += 1;
    },
    requestFinished: (status) => {
      requests.active = Math.max(0, requests.active - 1);
      if (status >= 500) requests.failed += 1;
      else if (status >= 400) requests.rejected += 1;
      else requests.succeeded += 1;
    },
    recordLeaseFailure: (kind) => {
      leases[kind] += 1;
    },
    counters: () => ({
      requests: { ...requests },
      leases: { ...leases },
    }),
    uptimeMs: () => Math.max(0, input.clock.now().getTime() - startedMs),
  };
}
