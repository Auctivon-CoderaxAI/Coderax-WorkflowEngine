import { z } from 'zod';
import { Availability, EngineCapabilities } from './capabilities.js';
import { CostClass, ModelRef, Usage } from './primitives.js';
import { ModelMediaCapability } from './media.js';

/** Recorded privacy term for a model; `unknown` is not an assurance. */
export const PromptTraining = z.enum(['prohibited', 'allowed', 'unknown']);
export type PromptTraining = z.infer<typeof PromptTraining>;

export const ModelDescriptor = z
  .object({
    ref: ModelRef,
    label: z.string().min(1).max(160),
    /**
     * `free` is a claim the engine verified for the configured provider, not a
     * guess from the identifier. A model whose cost class cannot be established
     * is reported as `paid` so it is refused by the zero-cost gate.
     */
    costClass: CostClass,
    contextTokens: z.number().int().positive().optional(),
    toolCalling: z.boolean(),
    streaming: z.boolean(),
    availability: Availability,
    /** What the model accepts on the wire; omitted means text only. */
    inputModalities: z.array(z.enum(['text', 'image'])).optional(),
    /** The recorded privacy term, never inferred from the provider name. */
    promptTraining: PromptTraining.optional(),
  })
  .strict();
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

export const ModelList = z
  .object({
    models: z.array(ModelDescriptor),
    /** The ordered candidates a free-inference route will consider. */
    route: z.array(ModelRef),
    allowPaid: z.literal(false),
    /** What this deployment can actually do with media, including what it cannot. */
    media: ModelMediaCapability.optional(),
  })
  .strict();
export type ModelList = z.infer<typeof ModelList>;

/** A per-task request and token ceiling. The engine refuses to exceed it. */
export const Budget = z
  .object({
    maxRequests: z.number().int().positive().max(10_000),
    maxInputTokens: z.number().int().positive().max(50_000_000),
    maxOutputTokens: z.number().int().positive().max(50_000_000),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;

export const BudgetState = z
  .object({
    budget: Budget,
    used: z.object({ requests: z.number().int().nonnegative(), usage: Usage }).strict(),
    remaining: z.object({ requests: z.number().int().nonnegative() }).strict(),
    exhausted: z.boolean(),
  })
  .strict();
export type BudgetState = z.infer<typeof BudgetState>;

export const EngineStatus = z
  .object({
    id: z.string().min(1).max(40),
    capabilities: EngineCapabilities,
    availability: Availability,
  })
  .strict();
export type EngineStatus = z.infer<typeof EngineStatus>;
