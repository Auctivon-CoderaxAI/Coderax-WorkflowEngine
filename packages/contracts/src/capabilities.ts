import { IsoDateTime } from './primitives.js';
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

/**
 * One registry for every capability the engine advertises.
 *
 * A capability is not a marketing category. Each row states what implements it,
 * whether a provider is configured, whether execution has actually been proven,
 * whether policy permits the data to leave the process and whether the route is
 * verified zero-cost. Provider documentation alone is never evidence: a row that
 * has not been executed is `unverified`, and a row with no implementation is
 * `unavailable`, never `available`.
 */

export const CAPABILITY_NAMES = [
  'text.intelligence',
  'image.understanding',
  'image.generation',
  'image.editing',
  'audio.understanding',
  'audio.transcription',
  'speech.generation',
  'video.understanding',
  'document.intelligence',
  'spreadsheet.intelligence',
  'presentation.intelligence',
  'data.analysis',
  'software.engineering',
  'browser.intelligence',
  'game.studio',
  'gaming.agent',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** Why a capability is not usable. `available` is the only usable state. */
export const CapabilityState = z.enum([
  'available',
  'unavailable',
  'unconfigured',
  'blocked',
  'unverified',
]);
export type CapabilityState = z.infer<typeof CapabilityState>;

export const CapabilityEntry = z
  .object({
    name: z.enum(CAPABILITY_NAMES),
    state: CapabilityState,
    /** The module that implements the capability, or `none`. */
    implementation: z.string().min(1).max(200),
    /** The configured provider, or null when the capability is deterministic. */
    provider: z.string().min(1).max(120).nullable(),
    providerConfigured: z.boolean(),
    /** True only when a real execution path has been exercised. */
    operational: z.boolean(),
    operationalDetail: z.string().min(1).max(400),
    /** Policy permits this processing operation in cloud mode. */
    privacyEligible: z.boolean(),
    /** A verified zero-cost route and no paid fallback. */
    zeroCost: z.boolean(),
    detail: z.string().min(1).max(400),
  })
  .strict();
export type CapabilityEntry = z.infer<typeof CapabilityEntry>;

export const CapabilityReport = z
  .object({
    at: IsoDateTime,
    capabilities: z.array(CapabilityEntry).min(1),
    summary: z
      .object({
        available: z.number().int().nonnegative(),
        unavailable: z.number().int().nonnegative(),
        unconfigured: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        unverified: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type CapabilityReport = z.infer<typeof CapabilityReport>;

export function summarizeCapabilities(
  capabilities: CapabilityEntry[],
  at: string,
): CapabilityReport {
  const summary = {
    available: 0,
    unavailable: 0,
    unconfigured: 0,
    blocked: 0,
    unverified: 0,
  };
  for (const capability of capabilities) summary[capability.state] += 1;
  return { at, capabilities, summary };
}
