import type {
  Availability,
  CostClass,
  DataMode,
  ModelRef,
  ProblemCode,
  Usage,
} from '@coderax/contracts';
import type { ProcessingOperation } from './policy.js';

/**
 * Model routing is the only place that chooses an inference endpoint. These
 * types describe what a provider reports, what the engine verified about it and
 * what a single attempt produced. Provider marketing is never a field here:
 * every free claim carries the evidence that established it.
 */
export type RoutingMode = 'auto' | 'fast' | 'complex';

/** `verified` needs local evidence; `declared` is provider metadata; unknown is unknown. */
export type CapabilityClass = 'verified' | 'declared' | 'unknown';

export type ModelCapabilities = {
  text: boolean;
  coding: CapabilityClass;
  reasoning: CapabilityClass;
  vision: boolean;
  toolCalling: boolean;
  streaming: boolean;
};

/**
 * What an adapter discovered. `pricing` is the provider's raw price object, not
 * a verdict: only the verifier may turn it into a cost class. `null` means the
 * provider published no price at all, which is not evidence of being free.
 */
export type DiscoveredModel = {
  ref: ModelRef;
  label: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  capabilities: {
    vision: boolean;
    toolCalling: boolean;
    reasoning: boolean;
    streaming: boolean;
  };
  pricing: Record<string, unknown> | null;
  deprecated?: boolean;
};

export type FreeTierAttestation = {
  providerId: string;
  modelId: string;
  /** The page that evidences the zero-cost tier; never a marketing home page. */
  evidenceUrl: string;
  verifiedAt: string;
  expiresAt: string;
  /** Only a USD zero amount is comparable; another currency is not evidence. */
  currency: 'USD';
  /**
   * The provider account the evidence was verified against. An attestation for a
   * different account says nothing about the key this deployment uses.
   */
  accountRef: string;
  /**
   * Why the account cannot incur a charge. A free *allowance* on an account with
   * a payment method is not a free tier: exceeding the allowance is billed, so
   * only an account that cannot be charged is accepted.
   */
  billing: 'no-payment-method' | 'spend-cap' | 'prepaid-credit-only';
  /** The hard spending cap recorded on the account. It must be exactly zero. */
  spendCapUsd: number;
  /** The published allowance, used to bound the engine's own daily ceiling. */
  quota: { requestsPerDay: number; tokensPerDay: number };
};

export type CostVerdict = {
  costClass: Extract<CostClass, 'free' | 'paid'>;
  basis: 'pricing' | 'attestation' | 'none';
  detail: string;
  /** Attestation expiry, when the claim is time-bounded. */
  expiresAt?: string;
  /** The allowance the evidence established, when it published one. */
  quota?: { requestsPerDay: number; tokensPerDay: number };
};

export type BenchmarkScore = {
  providerId: string;
  modelId: string;
  suite: string;
  suiteDigest: string;
  measuredAt: string;
  samples: number;
  coding: number;
  reasoning: number;
  toolCalling?: number;
};

export type ModelState = {
  ref: ModelRef;
  label: string;
  costClass: Extract<CostClass, 'free' | 'paid'>;
  costBasis: CostVerdict['basis'];
  costDetail: string;
  /** Attestation expiry enforced on every route, not only on refresh. */
  costExpiresAt: string | null;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: ModelCapabilities;
  quality: BenchmarkScore | null;
  /** A benchmark older than the configured window no longer ranks the model. */
  qualityValidUntil: string | null;
  supported: boolean;
  availability: Availability;
  discoveredAt: string;
  /** Index in the operator's preferred route, when it appears there. */
  preferredIndex: number | null;
};

export type NormalizedMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  /** Data URLs or https image references; only for vision-capable models. */
  images?: string[];
  toolCallId?: string;
  name?: string;
};

export type ToolSpec = {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  /** Set when the provider returned arguments that were not valid JSON. */
  rawArguments?: string;
};

export type ProviderCompletion = {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
  rateLimit?: RateLimitFacts;
};

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason?: string };

export type ProviderCompletionRequest = {
  model: ModelRef;
  system: string;
  prompt: string;
  messages?: NormalizedMessage[];
  tools?: ToolSpec[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
};

/**
 * Facts a provider returned about its own allowance. They are hints for the
 * limiter, never a guarantee: the engine still applies its configured ceiling.
 */
export type RateLimitFacts = {
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsMs?: number;
  resetTokensMs?: number;
  retryAfterMs?: number;
};

export type ProviderErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid'
  | 'context'
  | 'cancelled';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly quotaExhausted: boolean;
  readonly retryable: boolean;
  readonly rateLimit?: RateLimitFacts;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      quotaExhausted?: boolean;
      retryable?: boolean;
      rateLimit?: RateLimitFacts;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.quotaExhausted = options.quotaExhausted ?? kind === 'quota';
    this.retryable =
      options.retryable ??
      (kind === 'rate_limit' ||
        kind === 'quota' ||
        kind === 'server' ||
        kind === 'network' ||
        kind === 'timeout' ||
        kind === 'context');
    this.rateLimit = options.rateLimit;
  }
}

/**
 * A provider port. Discovery and completion are both provider-specific, while
 * everything above this boundary — cost verification, ranking, budgets,
 * circuits, fallback and health — is provider-independent.
 */
export type ProviderAdapter = {
  id: string;
  kind: 'openai' | 'gemini';
  discover: (signal?: AbortSignal) => Promise<DiscoveredModel[]>;
  complete: (request: ProviderCompletionRequest) => Promise<ProviderCompletion>;
  stream?: (request: ProviderCompletionRequest) => AsyncIterable<ProviderStreamEvent>;
};

export type ProviderSettings = {
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  discoveryIntervalMs: number;
};

export type RegisteredProvider = {
  adapter: ProviderAdapter;
  settings: ProviderSettings;
};

/**
 * The gateway the native agent consumes. It names a preferred model but never a
 * provider URL or key: fallback and health stay inside the router.
 */
export type GatewayRequest = {
  ownerId: string;
  /** Already resolved by the catalogue; never a raw provider override. */
  model: ModelRef;
  mode: DataMode;
  /**
   * The exact processing operation. It is required: a request without a
   * classification cannot prove it is authorized for one, so the router refuses
   * rather than guessing.
   */
  operation: ProcessingOperation;
  routing?: RoutingMode;
  /** An explicitly named model is pinned; an automatic route may fall back. */
  allowFallback?: boolean;
  system: string;
  prompt: string;
  messages?: NormalizedMessage[];
  tools?: ToolSpec[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  taskId?: string;
};

export type GatewayCompletion = {
  text: string;
  usage?: Usage;
  toolCalls: ToolCall[];
  model: ModelRef;
  attempts: ModelRef[];
  latencyMs: number;
};

export type GatewayStreamEvent =
  | ProviderStreamEvent
  | { type: 'model'; model: ModelRef; attempts: ModelRef[]; latencyMs: number };

export type ModelGateway = {
  id: string;
  /**
   * True when the transport can send native tool definitions. The agent still
   * decides per run; the router only forwards `tools` when the caller set them.
   */
  supportsNativeTools?: boolean;
  complete: (request: GatewayRequest) => Promise<GatewayCompletion>;
  stream?: (request: GatewayRequest) => AsyncIterable<GatewayStreamEvent>;
};

export type CircuitState = 'closed' | 'open' | 'half_open';

export type ModelHealth = {
  ref: ModelRef;
  label: string;
  costClass: Extract<CostClass, 'free' | 'paid'>;
  contextTokens: number | null;
  capabilities: ModelCapabilities;
  availability: Availability;
  available: boolean;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  latencyMs: number;
  circuit: CircuitState;
  lastFailureAt: string | null;
};

export type ProviderHealth = {
  providerId: string;
  available: boolean;
  lastDiscoveryAt: string | null;
  lastError: string | null;
  latencyMs: number;
  verifiedFreeModels: number;
  quotaUntil: string | null;
  circuit: CircuitState;
  /** Configured local ceiling, reported so a client sees the real limit. */
  requestsPerMinute: number;
  /**
   * Requests this replica admitted for dispatch in the last minute. Counted by
   * the limiter at admission and removed on a pre-dispatch refund, so it is a
   * measured value rather than the configured ceiling or a placeholder.
   */
  requestsThisMinute: number;
};

export type RouterHealth = {
  verifiedFree: number;
  route: ModelRef[];
  providers: ProviderHealth[];
  models: ModelHealth[];
};

export type RankedCandidate = {
  model: ModelState;
  score: number;
  reasons: string[];
};

/**
 * A refusal is a typed, user-safe failure. The message never contains a
 * provider payload, endpoint, key or filesystem path.
 */
export class ModelRoutingError extends Error {
  readonly code: ProblemCode;
  readonly retryable: boolean;

  constructor(code: ProblemCode, detail: string, retryable = false) {
    super(detail);
    this.name = 'ModelRoutingError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function routingFailure(
  error: unknown,
): { code: ProblemCode; detail: string; retryable: boolean } | null {
  if (!(error instanceof ModelRoutingError)) return null;
  return { code: error.code, detail: error.message, retryable: error.retryable };
}
