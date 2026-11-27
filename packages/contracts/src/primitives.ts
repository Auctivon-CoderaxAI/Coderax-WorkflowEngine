import { z } from 'zod';

/**
 * The contract version is part of the wire, not a comment. A client sends the
 * version it was built against and the engine reports the version it serves, so
 * a mismatch is observable instead of silent.
 */
export const CONTRACT_VERSION = '1.1.0' as const;
export const API_PREFIX = '/v1' as const;
export const EVENT_SCHEMA_VERSION = 1 as const;
/** Chat streaming frames are versioned separately from both HTTP and events. */
export const CHAT_STREAM_VERSION = 1 as const;

export type SemanticVersion = { major: number; minor: number; patch: number };

export function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * A client is compatible when it shares our major and does not ask for a newer
 * minor than this build serves. An older minor is accepted because every change
 * inside a major is additive.
 */
export function isContractVersionSupported(clientVersion: string): boolean {
  const parsed = parseSemanticVersion(clientVersion);
  if (!parsed) return false;
  if (parsed.major !== CONTRACT_MAJOR) return false;
  const current = parseSemanticVersion(CONTRACT_VERSION);
  if (!current) return false;
  return parsed.minor <= current.minor;
}

function identifier(label: string, max = 128) {
  return z.string().trim().min(1).max(max).describe(label);
}

export const OwnerId = identifier('owner identifier');
export type OwnerId = z.infer<typeof OwnerId>;

export const TenantId = identifier('tenant identifier');
export type TenantId = z.infer<typeof TenantId>;

export const ConversationId = identifier('conversation identifier');
export type ConversationId = z.infer<typeof ConversationId>;

export const TaskId = identifier('task identifier');
export type TaskId = z.infer<typeof TaskId>;

export const MessageId = identifier('message identifier');
export type MessageId = z.infer<typeof MessageId>;

export const BrowserSessionId = identifier('browser session identifier');
export type BrowserSessionId = z.infer<typeof BrowserSessionId>;

export const BrowserArtifactId = identifier('browser artifact identifier');
export type BrowserArtifactId = z.infer<typeof BrowserArtifactId>;

export const ScheduleId = identifier('schedule identifier');
export type ScheduleId = z.infer<typeof ScheduleId>;

export const ExecutionId = identifier('schedule execution identifier');
export type ExecutionId = z.infer<typeof ExecutionId>;

export const ArtifactId = identifier('artifact identifier');
export type ArtifactId = z.infer<typeof ArtifactId>;

export const ProjectId = identifier('project identifier');
export type ProjectId = z.infer<typeof ProjectId>;

/** Content addresses are lowercase hex so two clients cannot disagree on case. */
export const Sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hexadecimal characters')
  .describe('SHA-256 content hash');
export type Sha256 = z.infer<typeof Sha256>;

export const RequestId = identifier('request correlation identifier');
export type RequestId = z.infer<typeof RequestId>;

/**
 * Data modes are a security boundary. A private run may never read cloud
 * content and a cloud run may never read private content; workspaces, memory
 * and transcripts are all partitioned by this field.
 */
export const DataMode = z.enum(['private', 'cloud']);
export type DataMode = z.infer<typeof DataMode>;

/** The three agent identities Coderax exposes. External agents are optional. */
export const AgentId = z.enum(['coderax', 'opencode', 'freebuff']);
export type AgentId = z.infer<typeof AgentId>;

/** Execution engines. `native` is Coderax's own and has no external dependency. */
export const EngineId = z.enum(['native', 'opencode', 'freebuff']);
export type EngineId = z.infer<typeof EngineId>;

/** Agent selection maps to exactly one engine. There is no implicit substitution. */
export const AGENT_ENGINE: Readonly<Record<AgentId, EngineId>> = Object.freeze({
  coderax: 'native',
  opencode: 'opencode',
  freebuff: 'freebuff',
});

export function engineForAgent(agent: AgentId): EngineId {
  return AGENT_ENGINE[agent];
}

export const EngineFailureCode = z.enum([
  'disabled',
  'sdk_unavailable',
  'not_configured',
  'server_unavailable',
  'workspace_denied',
  'busy',
  'timeout',
  'cancelled',
  'protocol_error',
  'provider_error',
  'budget_exhausted',
  'paid_model_refused',
  'model_missing',
  'approval_required',
]);
export type EngineFailureCode = z.infer<typeof EngineFailureCode>;

/**
 * A task's state is authoritative only in the engine. Clients render it; they
 * never derive it. `interrupted` is terminal and is what a crashed or fenced
 * run becomes, so a dead process can never leave a task "running" forever.
 */
export const TaskState = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_TASK_STATES = ['completed', 'failed', 'cancelled', 'interrupted'] as const;

export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** Zero-cost enforcement is a contract, not a preference. */
export const CostClass = z.enum(['free', 'paid']);
export type CostClass = z.infer<typeof CostClass>;

export const ModelRef = z
  .object({
    providerId: identifier('provider identifier', 64),
    modelId: identifier('model identifier', 160),
  })
  .strict();
export type ModelRef = z.infer<typeof ModelRef>;

export const Usage = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Usage = z.infer<typeof Usage>;

export const IsoDateTime = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export function modelKey(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`;
}
