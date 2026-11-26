import { z } from 'zod';
import { AgentId, EngineId } from './primitives.js';

export const EngineCapabilities = z
  .object({
    streaming: z.boolean(),
    tools: z.boolean(),
    cancellation: z.boolean(),
    resume: z.boolean(),
    modelSelection: z.boolean(),
    durable: z.boolean(),
    /** The adapter accepts image content; routing still needs a vision model. */
    imageInput: z.boolean().optional(),
  })
  .strict();
export type EngineCapabilities = z.infer<typeof EngineCapabilities>;

/**
 * Why an agent cannot run is reported as truthfully as why it can. A client
 * shows an unavailable agent as unavailable; it is never hidden or replaced by
 * another agent.
 */
export const AvailabilityReason = z.enum([
  'ready',
  'disabled',
  'not_configured',
  'sdk_unavailable',
  'server_unavailable',
  'model_missing',
  'forbidden',
  'not_ready',
]);
export type AvailabilityReason = z.infer<typeof AvailabilityReason>;

export const Availability = z
  .object({
    available: z.boolean(),
    reason: AvailabilityReason,
    detail: z.string().max(500),
  })
  .strict();
export type Availability = z.infer<typeof Availability>;

/**
 * External agents receive nothing by default. `memory: 'none'` and
 * `credentials: 'none'` are the safe values and the engine refuses to widen them
 * for an untrusted adapter.
 */
export const AgentIsolation = z
  .object({
    workspace: z.literal('isolated'),
    memory: z.enum(['none', 'granted']),
    credentials: z.enum(['none', 'scoped']),
    conversations: z.enum(['none', 'granted']),
  })
  .strict();
export type AgentIsolation = z.infer<typeof AgentIsolation>;

export const AgentDescriptor = z
  .object({
    id: AgentId,
    engine: EngineId,
    label: z.string().min(1).max(80),
    external: z.boolean(),
    capabilities: EngineCapabilities,
    availability: Availability,
    isolation: AgentIsolation,
  })
  .strict();
export type AgentDescriptor = z.infer<typeof AgentDescriptor>;

export const AgentList = z.object({ agents: z.array(AgentDescriptor) }).strict();
export type AgentList = z.infer<typeof AgentList>;
