import { z } from 'zod';
import { RequestId } from './primitives.js';

/**
 * Stable, machine-readable failure codes. A client branches on `code`; `detail`
 * is user-safe text and never carries a stack, a query, a credential, an
 * absolute path or an upstream payload.
 */
export const ProblemCode = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'payload_too_large',
  'unsupported_media_type',
  'quota_exceeded',
  'storage_unavailable',
  'conflict',
  'busy',
  'not_ready',
  'engine_unavailable',
  'engine_not_configured',
  'browser_unavailable',
  'model_missing',
  'workspace_denied',
  'budget_exhausted',
  'paid_model_refused',
  'permission_required',
  'cancelled',
  'protocol_error',
  'internal_error',
]);
export type ProblemCode = z.infer<typeof ProblemCode>;

export const Problem = z
  .object({
    type: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    code: ProblemCode,
    detail: z.string().max(2000).optional(),
    requestId: RequestId.optional(),
    retryable: z.boolean(),
  })
  .strict();
export type Problem = z.infer<typeof Problem>;

export const HTTP_STATUS_FOR_CODE: Readonly<Record<ProblemCode, number>> = Object.freeze({
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  quota_exceeded: 507,
  storage_unavailable: 503,
  conflict: 409,
  busy: 409,
  not_ready: 503,
  engine_unavailable: 503,
  engine_not_configured: 503,
  browser_unavailable: 503,
  model_missing: 503,
  workspace_denied: 403,
  budget_exhausted: 429,
  paid_model_refused: 402,
  permission_required: 409,
  cancelled: 409,
  protocol_error: 502,
  internal_error: 500,
});
