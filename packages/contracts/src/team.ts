import { z } from 'zod';
import { AgentId, DataMode, IsoDateTime } from './primitives.js';
import { Budget } from './models.js';

/**
 * A team is a bounded set of agent members with a dependency graph, not a second
 * scheduler. Members run through the same execution supervisor as a Work task,
 * spend through the same zero-cost quota, ask the same permission store and
 * publish to the same event stream. The team record only orders them and proves
 * completion from evidence.
 */

export const TeamId = z.string().trim().min(1).max(128).describe('team identifier');
export type TeamId = z.infer<typeof TeamId>;

export const TeamMemberId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'member ids are stable identifiers');
export type TeamMemberId = z.infer<typeof TeamMemberId>;

export const TeamState = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TeamState = z.infer<typeof TeamState>;

export const TeamMemberState = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export type TeamMemberState = z.infer<typeof TeamMemberState>;

/**
 * A resource is a workspace-relative path. It is the unit a lock covers and the
 * exact resource a permission grant names; it is never widened to a directory.
 */
export const TeamResource = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'a team resource must be a confined workspace-relative path',
  );
export type TeamResource = z.infer<typeof TeamResource>;

export const TeamMemberSpec = z
  .object({
    memberId: TeamMemberId,
    /** Explicitly selected; the engine never substitutes one agent for another. */
    agent: AgentId,
    objective: z.string().trim().min(1).max(8000),
    dependsOn: z.array(TeamMemberId).max(32).default([]),
    /** Exact paths this member may observe; one durable grant is required per path. */
    resources: z.array(TeamResource).max(16).default([]),
  })
  .strict();
export type TeamMemberSpec = z.infer<typeof TeamMemberSpec>;

/**
 * Completion checks are objective. An artifact is hashed by the engine from the
 * real file; a test check reads a stored JSON result and requires at least one
 * test with zero failures. A model's `VERDICT: PASS` is never a check.
 */
export const TeamCheck = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('evidence'),
      memberId: TeamMemberId,
      description: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('artifact'),
      path: TeamResource,
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      minBytes: z.number().int().min(0).max(1_000_000_000).optional(),
      description: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('test'),
      /** A JSON file of `{ total, passed, failed }` written by the test runner. */
      path: TeamResource,
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      description: z.string().trim().max(500).optional(),
    })
    .strict(),
]);
export type TeamCheck = z.infer<typeof TeamCheck>;

export const TeamLimits = z
  .object({
    maxMembers: z.number().int().min(1).max(64),
    maxParallel: z.number().int().min(1).max(16),
    maxDurationMs: z.number().int().min(1_000).max(86_400_000),
    maxStepsPerMember: z.number().int().min(1).max(64),
  })
  .strict();
export type TeamLimits = z.infer<typeof TeamLimits>;

export const TeamSubmitRequest = z
  .object({
    objective: z.string().trim().min(1).max(8000),
    mode: DataMode,
    members: z.array(TeamMemberSpec).min(1).max(64),
    /** Optional objective checks; completion still requires member evidence. */
    checks: z.array(TeamCheck).max(16).optional(),
    budget: Budget.optional(),
    /** Native work is inferred from the objective unless the owner asks otherwise. */
    reasoning: z.enum(['auto', 'fast', 'complex']).optional(),
  })
  .strict();
export type TeamSubmitRequest = z.infer<typeof TeamSubmitRequest>;

export const TeamAccepted = z
  .object({
    teamId: TeamId,
    state: TeamState,
    generation: z.number().int().min(1),
    acceptedAt: IsoDateTime,
  })
  .strict();
export type TeamAccepted = z.infer<typeof TeamAccepted>;

export const TeamControlResult = z
  .object({
    teamId: TeamId,
    outcome: z.enum(['accepted', 'refused']),
    state: TeamState,
    generation: z.number().int().min(1),
  })
  .strict();
export type TeamControlResult = z.infer<typeof TeamControlResult>;

export const TeamMemberStatus = z
  .object({
    memberId: TeamMemberId,
    agent: AgentId,
    objective: z.string(),
    dependsOn: z.array(TeamMemberId),
    resources: z.array(z.string()),
    state: TeamMemberState,
    attempts: z.number().int().min(0),
    executionId: z.string().optional(),
    summary: z.string().max(4000).optional(),
    evidence: z.string().max(4000).optional(),
    failureCode: z.string().max(64).optional(),
    failureDetail: z.string().max(2000).optional(),
    startedAt: IsoDateTime.optional(),
    finishedAt: IsoDateTime.optional(),
  })
  .strict();
export type TeamMemberStatus = z.infer<typeof TeamMemberStatus>;

export const TeamCheckResult = z
  .object({
    checkId: z.string(),
    kind: z.enum(['evidence', 'artifact', 'test']),
    passed: z.boolean(),
    detail: z.string().max(2000),
  })
  .strict();
export type TeamCheckResult = z.infer<typeof TeamCheckResult>;

export const TeamArtifactStatus = z
  .object({
    path: z.string(),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TeamArtifactStatus = z.infer<typeof TeamArtifactStatus>;

export const TeamVerificationStatus = z
  .object({
    passed: z.boolean(),
    reason: z.string().max(4000),
    /** Engine-produced results, one per declared check. Never a model verdict. */
    checks: z.array(TeamCheckResult),
    artifacts: z.array(TeamArtifactStatus),
  })
  .strict();
export type TeamVerificationStatus = z.infer<typeof TeamVerificationStatus>;

export const TeamStatus = z
  .object({
    teamId: TeamId,
    objective: z.string(),
    mode: DataMode,
    state: TeamState,
    generation: z.number().int().min(1),
    members: z.array(TeamMemberStatus),
    limits: TeamLimits,
    verification: TeamVerificationStatus.nullable(),
    failure: z
      .object({
        code: z.string().max(64),
        detail: z.string().max(2000).optional(),
        retryable: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
      })
      .strict()
      .nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    startedAt: IsoDateTime.nullable(),
    finishedAt: IsoDateTime.nullable(),
  })
  .strict();
export type TeamStatus = z.infer<typeof TeamStatus>;

export const TeamList = z.object({ teams: z.array(TeamStatus) }).strict();
export type TeamList = z.infer<typeof TeamList>;
