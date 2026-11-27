import type { DataMode } from '@coderax/contracts';

/**
 * The one provider policy registry.
 *
 * Cost verification answers "may this run for free". It says nothing about
 * whether the request may leave the process at all. That is a separate decision,
 * recorded here per provider, per execution mode and per exact processing
 * operation. Free inference is never treated as privacy-preserving: a zero price
 * is not a data-processing agreement.
 *
 * There is deliberately no fallback policy. A provider without a record, a mode
 * that is not listed, an operation that was not granted, an undeclared location,
 * a training claim or a shared credential all deny. Private mode denies every
 * hosted provider unless the owner approved exactly that operation with an
 * owner-managed credential, no stored retention, no training, and a declared
 * location. When nothing qualifies the router fails closed; it never substitutes
 * local inference, Ollama or the owner's PC.
 */

/** The exact processing a provider is asked to perform. Authorization is per operation. */
export const PROCESSING_OPERATIONS = [
  'chat',
  'work',
  'native_reasoning',
  'multi_agent',
  'memory',
  'rag',
  'document',
  'multimodal',
  'mcp',
  'external_agent',
] as const;
export type ProcessingOperation = (typeof PROCESSING_OPERATIONS)[number];

export const DATA_RETENTION = ['none', 'transient', 'stored', 'unknown'] as const;
/** What the provider may do with the content after answering. */
export type DataRetention = (typeof DATA_RETENTION)[number];

export const TRAINING_USE = ['prohibited', 'opt-out', 'permitted', 'unknown'] as const;
export type TrainingUse = (typeof TRAINING_USE)[number];

export const PROCESSING_LOCATIONS = ['owner-region', 'eu', 'us', 'global', 'unknown'] as const;
export type ProcessingLocation = (typeof PROCESSING_LOCATIONS)[number];

export const CREDENTIAL_SOURCES = ['owner-managed', 'deployment-managed', 'none'] as const;
/** Where the provider credential comes from. A shared deployment key is not a private boundary. */
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

/** One explicitly approved operation. An absent grant is a denial. */
export type PolicyGrant = {
  operation: ProcessingOperation;
  mode: DataMode;
  /** The exact location approved; it must equal the recorded provider terms. */
  location: ProcessingLocation;
};

/**
 * What the owner recorded about one provider. Every field is evidence the owner
 * supplied, not something inferred from a model identifier or a marketing page.
 */
export type ProviderPolicy = {
  providerId: string;
  retention: DataRetention;
  training: TrainingUse;
  location: ProcessingLocation;
  credentials: CredentialSource;
  /** Execution modes this provider may ever serve. */
  modes: readonly DataMode[];
  /** Explicit grants. There is no wildcard. */
  grants: readonly PolicyGrant[];
  /** https evidence for the recorded terms; never a marketing home page. */
  evidenceUrl: string;
  verifiedAt: string;
  /** null records a standing authorization; a date bounds it. */
  expiresAt: string | null;
};

export type PolicyDimension =
  | 'execution_mode'
  | 'authorization'
  | 'retention'
  | 'training'
  | 'location'
  | 'credential';

export type PolicyDecision =
  | {
      allowed: true;
      providerId: string;
      operation: ProcessingOperation;
      mode: DataMode;
      retention: DataRetention;
      location: ProcessingLocation;
    }
  | {
      allowed: false;
      dimension: PolicyDimension;
      detail: string;
    };

export class ProviderPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPolicyError';
  }
}

function instant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ProviderPolicyError(`provider policy ${field} must be an ISO instant`);
  }
  return parsed;
}

function deny(dimension: PolicyDimension, detail: string): PolicyDecision {
  return { allowed: false, dimension, detail };
}

/**
 * Validate the registry once, at construction. A duplicate provider record, a
 * non-https evidence URL or an invalid instant is a startup failure rather than a
 * policy that silently stops applying.
 */
export function createProviderPolicyRegistry(
  policies: readonly ProviderPolicy[],
): ProviderPolicyRegistry {
  const entries = new Map<string, ProviderPolicy>();
  for (const policy of policies) {
    if (entries.has(policy.providerId)) {
      throw new ProviderPolicyError(
        `provider policy record for ${policy.providerId} is declared more than once`,
      );
    }
    if (!policy.evidenceUrl.startsWith('https://')) {
      throw new ProviderPolicyError(
        `provider policy record for ${policy.providerId} must cite an https evidence URL`,
      );
    }
    instant(policy.verifiedAt, 'verifiedAt');
    if (policy.expiresAt !== null) instant(policy.expiresAt, 'expiresAt');
    for (const grant of policy.grants) {
      if (!PROCESSING_OPERATIONS.includes(grant.operation)) {
        throw new ProviderPolicyError(
          `provider policy record for ${policy.providerId} grants an unknown operation`,
        );
      }
    }
    entries.set(policy.providerId, policy);
  }

  function evaluate(input: {
    providerId: string;
    operation: ProcessingOperation;
    mode: DataMode;
    at: Date;
  }): PolicyDecision {
    const policy = entries.get(input.providerId);
    if (!policy) {
      return deny(
        'authorization',
        'No owner-approved provider policy record exists for this provider.',
      );
    }
    if (!policy.modes.includes(input.mode)) {
      return deny(
        'execution_mode',
        `This provider is not approved for ${input.mode} execution.`,
      );
    }
    const expiresAt = policy.expiresAt === null ? null : Date.parse(policy.expiresAt);
    if (expiresAt !== null && expiresAt <= input.at.getTime()) {
      return deny('authorization', 'The provider policy record has expired and must be re-verified.');
    }
    const grants = policy.grants.filter(
      (entry) => entry.operation === input.operation && entry.mode === input.mode,
    );
    if (grants.length === 0) {
      return deny(
        'authorization',
        `No owner grant approves ${input.operation} processing in ${input.mode} mode.`,
      );
    }
    if (policy.location === 'unknown') {
      return deny('location', 'The provider does not declare where it processes data.');
    }
    if (!grants.some((grant) => grant.location === policy.location)) {
      return deny(
        'location',
        'The approved processing location does not match the recorded provider terms.',
      );
    }
    if (input.mode === 'private' && policy.location === 'global') {
      return deny(
        'location',
        'Private execution requires a declared processing location, not a global route.',
      );
    }
    if (!retentionAllowed(input.mode, policy.retention)) {
      return deny(
        'retention',
        input.mode === 'private'
          ? 'Private execution requires no stored retention by the provider.'
          : 'The provider does not declare an acceptable retention policy.',
      );
    }
    if (!trainingAllowed(input.mode, policy.training)) {
      return deny(
        'training',
        input.mode === 'private'
          ? 'Private execution requires a provider that is prohibited from training on content.'
          : 'The provider does not declare an acceptable training policy.',
      );
    }
    if (!credentialAllowed(input.mode, policy.credentials)) {
      return deny(
        'credential',
        'Private execution requires an owner-managed credential; a deployment-wide credential is not a private boundary.',
      );
    }
    return {
      allowed: true,
      providerId: policy.providerId,
      operation: input.operation,
      mode: input.mode,
      retention: policy.retention,
      location: policy.location,
    };
  }

  return {
    evaluate,
    get: (providerId) => entries.get(providerId) ?? null,
    list: () => [...entries.values()],
  };
}

function retentionAllowed(mode: DataMode, retention: DataRetention): boolean {
  if (retention === 'none' || retention === 'transient') return true;
  return mode === 'cloud' && retention === 'stored';
}

function trainingAllowed(mode: DataMode, training: TrainingUse): boolean {
  if (training === 'prohibited') return true;
  return mode === 'cloud' && training === 'opt-out';
}

function credentialAllowed(mode: DataMode, credentials: CredentialSource): boolean {
  return mode === 'private' ? credentials === 'owner-managed' : true;
}

export type ProviderPolicyRegistry = {
  /** The only authority on whether a provider may process a request. */
  evaluate: (input: {
    providerId: string;
    operation: ProcessingOperation;
    mode: DataMode;
    at: Date;
  }) => PolicyDecision;
  get: (providerId: string) => ProviderPolicy | null;
  list: () => readonly ProviderPolicy[];
};
