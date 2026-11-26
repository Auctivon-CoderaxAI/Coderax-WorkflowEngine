import { z } from 'zod';
import {
  BrowserArtifactId,
  BrowserSessionId,
  IsoDateTime,
  RequestId,
} from './primitives.js';
import { PermissionRequest } from './permissions.js';

/**
 * Cloud browser and computer-use contract.
 *
 * Coderax owns the policy, the approvals and the receipts; a browser provider
 * owns only the remote session. Everything a page produces is untrusted data and
 * is marked as such, so no consumer can mistake rendered content for an
 * instruction or a permission.
 *
 * The contract deliberately describes a browser scope only. There is no
 * OS-level "computer" claim here: keyboard and mouse are page-level input, and
 * a provider that cannot honour that is not operational.
 */

export const BROWSER_PROTOCOL_VERSION = 1 as const;

export const BrowserSessionState = z.enum([
  'creating',
  'ready',
  'paused',
  'owner_controlled',
  'closed',
  'expired',
  'failed',
  /** Remote termination was not confirmed; never reused or treated as closed. */
  'quarantined',
]);
export type BrowserSessionState = z.infer<typeof BrowserSessionState>;

export const BrowserPurpose = z.enum(['research', 'testing', 'general']);
export type BrowserPurpose = z.infer<typeof BrowserPurpose>;

export const BrowserCapabilityReason = z.enum([
  'ready',
  'disabled',
  'not_configured',
  'unverified',
  'unreachable',
  'protocol_error',
  'missing_features',
  'paid_refused',
]);
export type BrowserCapabilityReason = z.infer<typeof BrowserCapabilityReason>;

/**
 * Every feature the integration contract requires. A provider that reports a
 * false value is not operational: partial remote automation would silently turn
 * a requested capability into a failure the owner only discovers mid-task.
 */
export const BrowserFeatures = z
  .object({
    sessions: z.boolean(),
    navigation: z.boolean(),
    inspection: z.boolean(),
    screenshots: z.boolean(),
    accessibleElements: z.boolean(),
    forms: z.boolean(),
    keyboard: z.boolean(),
    mouse: z.boolean(),
    tabs: z.boolean(),
    uploads: z.boolean(),
    downloads: z.boolean(),
    sessionPersistence: z.boolean(),
    pauseResume: z.boolean(),
    takeover: z.boolean(),
  })
  .strict();
export type BrowserFeatures = z.infer<typeof BrowserFeatures>;

export const BrowserLimits = z
  .object({
    maxSessionTtlSeconds: z.number().int().positive(),
    maxSessionsPerOwner: z.number().int().positive(),
    maxScreenshotBytes: z.number().int().positive(),
    maxUploadBytes: z.number().int().positive(),
  })
  .strict();
export type BrowserLimits = z.infer<typeof BrowserLimits>;

export const BrowserCapabilities = z
  .object({
    provider: z.string().min(1).max(120),
    /** True only when a session can be created and every feature is supported. */
    operational: z.boolean(),
    reason: BrowserCapabilityReason,
    detail: z.string().min(1).max(500),
    /** The integration's scope. OS-level desktop control is not implemented. */
    scope: z.literal('browser'),
    /** A paid provider is refused by the zero-cost charter. */
    costClass: z.enum(['free', 'paid', 'unknown']),
    features: BrowserFeatures,
    limits: BrowserLimits,
    checkedAt: IsoDateTime,
  })
  .strict();
export type BrowserCapabilities = z.infer<typeof BrowserCapabilities>;

export const BrowserTab = z
  .object({
    tabId: z.string().min(1).max(200),
    url: z.string().max(2048),
    title: z.string().max(300),
    active: z.boolean(),
  })
  .strict();
export type BrowserTab = z.infer<typeof BrowserTab>;

/**
 * A session always runs in cloud infrastructure. The field is a literal so a
 * client cannot request the owner's computer as the execution environment.
 */
export const BrowserSession = z
  .object({
    sessionId: BrowserSessionId,
    label: z.string().min(1).max(120),
    purpose: BrowserPurpose,
    state: BrowserSessionState,
    environment: z.literal('cloud'),
    provider: z.string().min(1).max(120),
    url: z.string().max(2048),
    title: z.string().max(300),
    tabs: z.array(BrowserTab).max(20),
    allowedOrigins: z.array(z.string().min(1).max(300)).min(1).max(20),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    expiresAt: IsoDateTime,
    closedAt: IsoDateTime.optional(),
    failure: z
      .object({ code: z.string().min(1).max(60), detail: z.string().max(500).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserSession = z.infer<typeof BrowserSession>;

export const BrowserSessionList = z
  .object({ sessions: z.array(BrowserSession) })
  .strict();
export type BrowserSessionList = z.infer<typeof BrowserSessionList>;

export const BrowserViewport = z
  .object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  })
  .strict();
export type BrowserViewport = z.infer<typeof BrowserViewport>;

export const BrowserSessionCreateRequest = z
  .object({
    label: z.string().trim().min(1).max(120),
    purpose: BrowserPurpose.default('general'),
    /**
     * Exact origins the session may visit. Navigation outside this list is
     * refused by the engine and must also be enforced by the provider.
     */
    origins: z.array(z.string().trim().min(3).max(300)).min(1).max(20),
    ttlSeconds: z.number().int().min(60).max(3600).optional(),
    viewport: BrowserViewport.optional(),
  })
  .strict();
export type BrowserSessionCreateRequest = z.infer<typeof BrowserSessionCreateRequest>;

export const BrowserCloseRequest = z
  .object({ reason: z.string().max(500).optional() })
  .strict();
export type BrowserCloseRequest = z.infer<typeof BrowserCloseRequest>;

export const BrowserTakeoverRequest = z
  .object({ active: z.boolean() })
  .strict();
export type BrowserTakeoverRequest = z.infer<typeof BrowserTakeoverRequest>;

export const BrowserTakeoverResult = z
  .object({
    session: BrowserSession,
    /**
     * A provider-issued live view. It is returned once and never persisted in a
     * receipt or the session record.
     */
    interactiveUrl: z.string().max(4096).optional(),
  })
  .strict();
export type BrowserTakeoverResult = z.infer<typeof BrowserTakeoverResult>;

/** Categories that always need an explicit, single-use owner approval. */
export const BrowserSensitiveCategory = z.enum([
  'file_transfer',
  'authentication',
  'account_change',
  'purchase',
  'irreversible',
]);
export type BrowserSensitiveCategory = z.infer<typeof BrowserSensitiveCategory>;

/**
 * The caller's declared intent. It is evidence and a policy input, never
 * authority: a missing intent fails closed for a committing action, and page
 * content cannot change the declared intent.
 */
export const BrowserIntentCategory = z.enum([
  'read',
  'navigate',
  'form_input',
  'file_transfer',
  'authentication',
  'account_change',
  'purchase',
  'irreversible',
]);
export type BrowserIntentCategory = z.infer<typeof BrowserIntentCategory>;

export const BrowserIntent = z
  .object({
    category: BrowserIntentCategory,
    description: z.string().min(1).max(500),
  })
  .strict();
export type BrowserIntent = z.infer<typeof BrowserIntent>;

export const BrowserElementTarget = z
  .object({ elementId: z.string().trim().min(1).max(200) })
  .strict();
export type BrowserElementTarget = z.infer<typeof BrowserElementTarget>;

export const BrowserActionType = z.enum([
  'navigate',
  'inspect',
  'screenshot',
  'find',
  'click',
  'fill',
  'press',
  'mouse',
  'tab',
  'upload',
  'download',
]);
export type BrowserActionType = z.infer<typeof BrowserActionType>;

const intentField = { intent: BrowserIntent.optional() };
const approvalField = { approvalId: RequestId.optional() };

/**
 * One user-visible action. Element addressing is by provider-issued element id
 * from a prior observation, not by page-supplied markup, so an action cannot be
 * aimed at an element the owner never saw.
 */
export const BrowserAction = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('navigate'),
        url: z.string().trim().url().max(2048),
        ...intentField,
      })
      .strict(),
    z
      .object({
        type: z.literal('inspect'),
        maxTextChars: z.number().int().min(200).max(20_000).default(20_000),
        includeElements: z.boolean().default(true),
      })
      .strict(),
    z
      .object({
        type: z.literal('screenshot'),
        fullPage: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        type: z.literal('find'),
        query: z.string().max(200).optional(),
        role: z.string().max(64).optional(),
        name: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    z
      .object({
        type: z.literal('click'),
        target: BrowserElementTarget,
        button: z.enum(['left', 'middle', 'right']).default('left'),
        clickCount: z.number().int().min(1).max(2).default(1),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('fill'),
        target: BrowserElementTarget,
        value: z.string().max(10_000),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('press'),
        key: z.string().trim().min(1).max(50),
        target: BrowserElementTarget.optional(),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('mouse'),
        input: z.enum(['move', 'down', 'up', 'wheel']),
        x: z.number().int().min(0).max(20_000),
        y: z.number().int().min(0).max(20_000),
        button: z.enum(['left', 'middle', 'right']).optional(),
        deltaY: z.number().int().min(-10_000).max(10_000).optional(),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('tab'),
        input: z.enum(['list', 'open', 'close', 'activate']),
        tabId: z.string().trim().min(1).max(200).optional(),
        url: z.string().trim().url().max(2048).optional(),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('upload'),
        target: BrowserElementTarget,
        filename: z.string().trim().min(1).max(200),
        contentType: z.string().trim().min(3).max(120),
        dataBase64: z.string().min(4).max(700_000),
        ...intentField,
        ...approvalField,
      })
      .strict(),
    z
      .object({
        type: z.literal('download'),
        target: BrowserElementTarget,
        ...intentField,
        ...approvalField,
      })
      .strict(),
  ])
  .superRefine((action, context) => {
    if (action.type !== 'tab') return;
    if (action.input === 'open' && !action.url) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'opening a tab requires url',
      });
    }
    if ((action.input === 'close' || action.input === 'activate') && !action.tabId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tabId'],
        message: `${action.input} requires tabId`,
      });
    }
  });
export type BrowserAction = z.infer<typeof BrowserAction>;

export const BrowserElement = z
  .object({
    elementId: z.string().min(1).max(200),
    role: z.string().min(1).max(64),
    name: z.string().max(300),
    value: z.string().max(1000).optional(),
    inputType: z.string().max(64).optional(),
    disabled: z.boolean(),
    focused: z.boolean(),
  })
  .strict();
export type BrowserElement = z.infer<typeof BrowserElement>;

/**
 * Everything a page says is untrusted. `trust` is a literal so a client that
 * feeds this into a model must relabel it as data, and the engine never consults
 * it when deciding whether an action is allowed.
 */
export const BrowserObservation = z
  .object({
    url: z.string().max(2048),
    title: z.string().max(300),
    text: z.string().max(20_000).optional(),
    elements: z.array(BrowserElement).max(200),
    tabs: z.array(BrowserTab).max(20),
    trust: z.literal('untrusted'),
    truncated: z.boolean(),
  })
  .strict();
export type BrowserObservation = z.infer<typeof BrowserObservation>;

export const BrowserArtifactKind = z.enum(['screenshot', 'download', 'upload']);
export type BrowserArtifactKind = z.infer<typeof BrowserArtifactKind>;

export const BrowserArtifact = z
  .object({
    artifactId: BrowserArtifactId,
    sessionId: BrowserSessionId,
    kind: BrowserArtifactKind,
    contentType: z.string().min(3).max(120),
    bytes: z.number().int().nonnegative(),
    /** SHA-256 of the exact bytes the engine received. */
    digest: z.string().min(64).max(64),
    createdAt: IsoDateTime,
  })
  .strict();
export type BrowserArtifact = z.infer<typeof BrowserArtifact>;

export const BrowserArtifactContent = z
  .object({
    artifact: BrowserArtifact,
    dataBase64: z.string(),
  })
  .strict();
export type BrowserArtifactContent = z.infer<typeof BrowserArtifactContent>;

export const BrowserActionResult = z
  .object({
    sessionId: BrowserSessionId,
    receiptId: z.string().min(1).max(120),
    action: BrowserActionType,
    state: BrowserSessionState,
    observation: BrowserObservation.optional(),
    artifact: BrowserArtifact.optional(),
    at: IsoDateTime,
  })
  .strict();
export type BrowserActionResult = z.infer<typeof BrowserActionResult>;

export const BrowserReceiptAction = z.enum([
  'session.create',
  'navigate',
  'inspect',
  'screenshot',
  'find',
  'click',
  'fill',
  'press',
  'mouse',
  'tab',
  'upload',
  'download',
  'pause',
  'resume',
  'takeover',
  'release',
  'close',
]);
export type BrowserReceiptAction = z.infer<typeof BrowserReceiptAction>;

export const BrowserReceipt = z
  .object({
    receiptId: z.string().min(1).max(120),
    sessionId: BrowserSessionId,
    action: BrowserReceiptAction,
    outcome: z.enum(['succeeded', 'refused', 'failed']),
    provider: z.string().min(1).max(120),
    at: IsoDateTime,
    durationMs: z.number().int().nonnegative(),
    approvalId: RequestId.optional(),
    artifactId: BrowserArtifactId.optional(),
    /** User-safe explanation; never page text, a URL credential or a stack. */
    detail: z.string().max(500).optional(),
  })
  .strict();
export type BrowserReceipt = z.infer<typeof BrowserReceipt>;

export const BrowserReceiptList = z
  .object({ receipts: z.array(BrowserReceipt) })
  .strict();
export type BrowserReceiptList = z.infer<typeof BrowserReceiptList>;

export const BrowserAuthorizationRequest = z
  .object({
    category: BrowserSensitiveCategory,
    description: z.string().trim().min(1).max(500),
  })
  .strict();
export type BrowserAuthorizationRequest = z.infer<typeof BrowserAuthorizationRequest>;

export const BrowserAuthorization = z
  .object({ request: PermissionRequest })
  .strict();
export type BrowserAuthorization = z.infer<typeof BrowserAuthorization>;
