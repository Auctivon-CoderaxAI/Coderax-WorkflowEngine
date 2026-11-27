import { z } from 'zod';

/**
 * The release train is deliberately limited to the three existing repositories.
 * A fourth repository is not representable, so no release can silently widen the
 * component set it was verified against.
 */
export const RELEASE_SCHEMA = 'coderax.release-train/1' as const;

export const REPOSITORY = {
  engine: 'Auctivon-CoderaxAI/Coderax-WorkflowEngine',
  web: 'Auctivon-CoderaxAI/Coderax',
  cli: 'Auctivon-CoderaxAI/CoderaxCLI',
} as const;

export type ComponentRole = keyof typeof REPOSITORY;

export const Commit = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character lowercase commit SHA');
export type Commit = z.infer<typeof Commit>;

export const Semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be a three-part semver');
export type Semver = z.infer<typeof Semver>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256');
export type Sha256 = z.infer<typeof Sha256>;

export const Sha512 = z.string().regex(/^[0-9a-f]{128}$/, 'must be a lowercase hex SHA-512');
export type Sha512 = z.infer<typeof Sha512>;

export const IsoDateTime = z.string().datetime({ offset: true });

const EvidenceRef = z
  .object({
    path: z.string().min(1).max(300),
    line: z.number().int().positive().max(500_000),
    statement: z.string().min(1).max(600),
    sha256: Sha256,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const AUDIT_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
  'not-run',
  'unknown',
] as const;

const CheckEvidence = z
  .object({
    workflow: z.string().min(1).max(120),
    job: z.string().min(1).max(120),
    required: z.boolean(),
    headSha: Commit.nullable(),
    conclusion: z.enum(AUDIT_CONCLUSIONS),
    url: z.string().url().nullable(),
    checkedAt: IsoDateTime.nullable(),
  })
  .strict();
export type CheckEvidence = z.infer<typeof CheckEvidence>;

const Review = z
  .object({
    author: z.string().min(1).max(120).nullable(),
    reviewer: z.string().min(1).max(120).nullable(),
    status: z.enum(['approved', 'changes-requested', 'not-reviewed']),
    headSha: Commit.nullable(),
    reviewedAt: IsoDateTime.nullable(),
  })
  .strict();
export type Review = z.infer<typeof Review>;

const Rollback = z
  .object({
    mode: z.enum(['pre-cutover-abort', 'revert-commit', 'redeploy-previous', 'client-release-revert']),
    targetCommit: Commit.nullable(),
    dataDeletion: z.literal(false),
    contractCompatible: z.boolean(),
    notes: z.string().min(1).max(600),
  })
  .strict();
export type Rollback = z.infer<typeof Rollback>;

const Deployment = z
  .object({
    deployed: z.boolean(),
    origin: z.string().url().nullable(),
    servedCommit: Commit.nullable(),
    healthContractVersion: Semver.nullable(),
    verifiedAt: IsoDateTime.nullable(),
  })
  .strict();
export type Deployment = z.infer<typeof Deployment>;

const LocalVerification = z
  .object({
    command: z.string().min(1).max(200),
    headCommit: Commit,
    exitCode: z.union([z.literal(0), z.literal(1)]),
    tests: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    ranAt: IsoDateTime,
    path: z.string().min(1).max(300),
    outputSha256: Sha256,
  })
  .strict();
export type LocalVerification = z.infer<typeof LocalVerification>;

const Migration = z
  .object({
    id: z.string().min(1).max(120),
    collection: z.string().min(1).max(120),
    operation: z.literal('createIndex'),
    keys: z.record(z.union([z.literal(1), z.literal(-1)])),
    unique: z.boolean(),
    name: z.string().min(1).max(120),
    required: z.boolean(),
    reversible: z.boolean(),
    rollback: z.string().min(1).max(300),
  })
  .strict();
export type Migration = z.infer<typeof Migration>;

const PersistedSdk = z
  .object({
    path: z.string().regex(/^release\/artifacts\/[A-Za-z0-9._-]+\.tgz$/),
    sha256: Sha256,
    sha512: Sha512,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
    files: z.array(z.string().min(1).max(300)).min(3),
  })
  .strict();
export type PersistedSdk = z.infer<typeof PersistedSdk>;

const Engine = z
  .object({
    repository: z.literal(REPOSITORY.engine),
    commit: Commit,
    ref: z.string().min(1).max(200),
    version: Semver,
    apiContract: Semver,
    sdkVersion: Semver,
    eventSchema: z.number().int().positive(),
    sdkArtifact: PersistedSdk,
    openapi: z
      .object({ path: z.literal('openapi.json'), sha256: Sha256 })
      .strict(),
    migrations: z.array(Migration).min(1),
    requiredChecks: z.array(CheckEvidence).min(1),
    review: Review,
    deployment: Deployment,
    rollback: Rollback,
    localVerification: LocalVerification,
  })
  .strict();
export type EngineManifest = z.infer<typeof Engine>;

const ClientIntegration = z
  .object({
    status: z.enum(['integrated', 'not-integrated']),
    reason: z.string().min(1).max(600),
    sdkVersion: Semver.nullable(),
    sdkArtifactSha256: Sha256.nullable(),
    apiContract: Semver.nullable(),
    eventSchema: z.number().int().positive().nullable(),
    engineOrigin: z.string().url().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const fields = [
      value.sdkVersion,
      value.sdkArtifactSha256,
      value.apiContract,
      value.eventSchema,
      value.engineOrigin,
    ];
    if (value.status === 'integrated' && fields.some((field) => field === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an integrated client must declare every compatibility field',
      });
    }
    if (value.status === 'not-integrated' && fields.some((field) => field !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a not-integrated client must not declare compatibility fields',
      });
    }
  });
export type ClientIntegration = z.infer<typeof ClientIntegration>;

const Client = z
  .object({
    repository: z.enum([REPOSITORY.web, REPOSITORY.cli]),
    commit: Commit,
    ref: z.string().min(1).max(200),
    version: z.string().min(1).max(60),
    integration: ClientIntegration,
    evidence: z.array(EvidenceRef).min(1),
    requiredChecks: z.array(CheckEvidence).min(1),
    review: Review,
    deployment: Deployment,
    rollback: Rollback,
  })
  .strict();
export type ClientManifest = z.infer<typeof Client>;

const UnpublishedCommit = z
  .object({
    repository: z.literal(REPOSITORY.engine),
    branch: z.string().min(1).max(200),
    commit: Commit,
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    disposition: z.enum(['pending-merge', 'superseded', 'excluded']),
    summary: z.string().min(1).max(600),
    supersededBy: Commit.nullable(),
    exclusion: z
      .object({
        owner: z.string().min(1).max(120),
        rationale: z.string().min(1).max(600),
        recordedAt: IsoDateTime,
      })
      .strict()
      .nullable(),
    evidence: z.array(EvidenceRef).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition === 'superseded' && value.supersededBy === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a superseded branch must name the commit that supersedes it',
      });
    }
    if (value.disposition === 'excluded' && value.exclusion === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an excluded branch must record an owner exclusion',
      });
    }
  });
export type UnpublishedCommit = z.infer<typeof UnpublishedCommit>;

const OwnerSignoff = z
  .object({
    repository: z.enum([REPOSITORY.engine, REPOSITORY.web, REPOSITORY.cli]),
    owner: z.string().min(1).max(120),
    requiredChecks: z.array(z.string().min(1).max(120)).min(1),
    status: z.enum(['signed', 'pending']),
    signedAt: IsoDateTime.nullable(),
  })
  .strict();
export type OwnerSignoff = z.infer<typeof OwnerSignoff>;

const CiPolicy = z
  .object({
    audit: z
      .object({
        path: z.literal('release/ci-audit.json'),
        sha256: Sha256,
      })
      .strict(),
    /**
     * Workflow files whose infrastructure mutation has been authorized by the
     * repository's CI owner. An empty list is honest: nothing has been signed.
     */
    authorizedDeployWorkflows: z.array(z.string().regex(/^[^:]+:\/\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/)),
    ownerSignoffs: z.array(OwnerSignoff).length(3),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set(value.ownerSignoffs.map((entry) => entry.repository));
    if (seen.size !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one CI owner sign-off is required per repository',
      });
    }
    for (const signoff of value.ownerSignoffs) {
      if (signoff.status === 'signed' && signoff.signedAt === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `a signed CI owner record needs a timestamp (${signoff.repository})`,
        });
      }
      if (signoff.status === 'pending' && signoff.signedAt !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `a pending CI owner record cannot have a timestamp (${signoff.repository})`,
        });
      }
    }
  });

const AuthoritativeEngine = z
  .object({
    origin: z.string().url().nullable(),
    apiPrefix: z.literal('/v1'),
    contractVersion: Semver,
    eventSchema: z.number().int().positive(),
  })
  .strict();

export const ReleaseManifestSchema = z
  .object({
    schema: z.literal(RELEASE_SCHEMA),
    train: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,40}$/),
    createdAt: IsoDateTime,
    cutover: z
      .object({
        executed: z.boolean(),
        at: IsoDateTime.nullable(),
      })
      .strict(),
    authoritativeEngine: AuthoritativeEngine,
    engine: Engine,
    web: Client,
    cli: Client,
    ci: CiPolicy,
    unpublished: z.array(UnpublishedCommit),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.web.repository !== REPOSITORY.web) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['web', 'repository'],
        message: `web must be ${REPOSITORY.web}`,
      });
    }
    if (value.cli.repository !== REPOSITORY.cli) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cli', 'repository'],
        message: `cli must be ${REPOSITORY.cli}`,
      });
    }
    if (value.cutover.executed && value.cutover.at === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cutover', 'at'],
        message: 'an executed cutover needs a timestamp',
      });
    }
    if (!value.cutover.executed && value.cutover.at !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cutover', 'at'],
        message: 'an unexecuted cutover cannot carry a timestamp',
      });
    }
  });

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function parseReleaseManifest(text: string): ReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('release/train.json is not valid JSON');
  }
  const result = ReleaseManifestSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`release/train.json is not a valid release manifest:\n${detail}`);
  }
  return result.data;
}
