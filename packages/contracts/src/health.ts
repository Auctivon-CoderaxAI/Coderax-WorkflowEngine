import { z } from 'zod';
import { EngineStatus } from './models.js';
import { IsoDateTime } from './primitives.js';

// Strict /v1 health readers expect this literal. The handshake reports the
// currently served HTTP contract version.
export const HEALTH_REPORT_VERSION = '1.0.0' as const;

export const CheckStatus = z.enum(['ok', 'degraded', 'failed']);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const HealthCheck = z
  .object({
    name: z.string().min(1).max(80),
    status: CheckStatus,
    required: z.boolean(),
    detail: z.string().max(500).optional(),
  })
  .strict();
export type HealthCheck = z.infer<typeof HealthCheck>;

export const HealthReport = z
  .object({
    status: CheckStatus,
    contractVersion: z.literal(HEALTH_REPORT_VERSION),
    startedAt: IsoDateTime,
    uptimeMs: z.number().int().nonnegative(),
    checks: z.array(HealthCheck),
    engines: z.array(EngineStatus),
  })
  .strict();
export type HealthReport = z.infer<typeof HealthReport>;

/**
 * Readiness is deliberately narrower than health: it is false until every
 * required dependency and the configuration gate have been verified at startup.
 */
export const ReadinessReport = z
  .object({
    ready: z.boolean(),
    missing: z.array(z.string().max(120)),
    checks: z.array(HealthCheck),
  })
  .strict();
export type ReadinessReport = z.infer<typeof ReadinessReport>;
