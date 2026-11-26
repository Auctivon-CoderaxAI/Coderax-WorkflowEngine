import type {
  BrowserAction,
  BrowserActionResult,
  BrowserArtifact,
  BrowserArtifactContent,
  BrowserAuthorizationRequest,
  BrowserCapabilities,
  BrowserCloseRequest,
  BrowserElement,
  BrowserObservation,
  BrowserReceipt,
  BrowserReceiptAction,
  BrowserReceiptList,
  BrowserSensitiveCategory,
  BrowserSession,
  BrowserSessionCreateRequest,
  BrowserSessionList,
  BrowserTakeoverRequest,
  BrowserTakeoverResult,
  PermissionDecisionRequest,
  PermissionList,
  PermissionRequest,
  ProblemCode,
} from '@coderax/contracts';
import type { BrowserLimits } from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type { PermissionStore } from '../permissions/store.js';
import type { AuditLog } from '../observability/audit.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceFailure, ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { redactText } from '../observability/redact.js';
import type { BrowserProvider, ProviderFailure } from '../browser/types.js';
import type { BrowserStore, StoredBrowserSession } from '../browser/store.js';
import { unavailableCapabilities } from '../browser/capabilities.js';
import {
  decodeBase64,
  detectImageType,
  digestOf,
  isSafeTransferType,
  matchesImageType,
  normalizeOrigins,
  originAllowed,
  resourceFor,
  sanitizeElements,
  sanitizeFilename,
  sanitizeLabel,
  sanitizePageUrl,
  sanitizeTabs,
  sanitizeUntrusted,
  sensitivityFor,
  scopeFor,
  tabsWithinOrigins,
} from '../browser/policy.js';

/**
 * Cloud browser use cases.
 *
 * The service is the only place that combines an owner, a provider session, an
 * approval and a receipt. A page cannot grant permission, cannot widen the origin
 * allowlist and cannot turn an unverified provider into an operational one. Every
 * action leaves a receipt whether it succeeded, was refused or failed; a
 * screenshot exists only if the provider returned image bytes that the engine
 * verified and digested.
 */

export type BrowserService = {
  capabilities: () => Promise<BrowserCapabilities>;
  list: (ownerId: string) => Promise<BrowserSessionList>;
  get: (ownerId: string, sessionId: string) => Promise<ServiceResult<BrowserSession>>;
  create: (
    ownerId: string,
    request: BrowserSessionCreateRequest,
  ) => Promise<ServiceResult<BrowserSession>>;
  act: (
    ownerId: string,
    sessionId: string,
    action: BrowserAction,
  ) => Promise<ServiceResult<BrowserActionResult>>;
  pause: (ownerId: string, sessionId: string) => Promise<ServiceResult<BrowserSession>>;
  resume: (ownerId: string, sessionId: string) => Promise<ServiceResult<BrowserSession>>;
  takeover: (
    ownerId: string,
    sessionId: string,
    request: BrowserTakeoverRequest,
  ) => Promise<ServiceResult<BrowserTakeoverResult>>;
  close: (
    ownerId: string,
    sessionId: string,
    request: BrowserCloseRequest,
  ) => Promise<ServiceResult<BrowserSession>>;
  authorize: (
    ownerId: string,
    sessionId: string,
    request: BrowserAuthorizationRequest,
  ) => Promise<ServiceResult<PermissionRequest>>;
  decide: (
    ownerId: string,
    sessionId: string,
    request: PermissionDecisionRequest,
  ) => Promise<ServiceResult<PermissionList>>;
  receipts: (ownerId: string, sessionId: string) => Promise<ServiceResult<BrowserReceiptList>>;
  artifact: (
    ownerId: string,
    artifactId: string,
  ) => Promise<ServiceResult<BrowserArtifactContent>>;
  shutdown: () => Promise<void>;
};

export type BrowserServiceDeps = {
  config: EngineConfig;
  clock: Clock;
  ids: IdGenerator;
  permissions: PermissionStore;
  audit: AuditLog;
  provider: BrowserProvider;
  store: BrowserStore;
};

type AuditOutcome = 'accepted' | 'completed' | 'failed' | 'cancelled' | 'refused';

const TERMINAL_STATES = new Set(['closed', 'expired', 'failed', 'quarantined']);
const APPROVAL_TTL_MS = 10 * 60_000;

function limitsFor(config: EngineConfig): BrowserLimits {
  return {
    maxSessionTtlSeconds: Math.floor(config.browsers.sessionTtlMs / 1000),
    maxSessionsPerOwner: config.browsers.maxSessionsPerOwner,
    maxScreenshotBytes: config.browsers.maxScreenshotBytes,
    maxUploadBytes: config.browsers.maxUploadBytes,
  };
}

function isLive(session: BrowserSession): boolean {
  return (
    session.state === 'ready' ||
    session.state === 'paused' ||
    session.state === 'owner_controlled' ||
    session.state === 'creating'
  );
}

function toContract(record: StoredBrowserSession): BrowserSession {
  return {
    ...record.session,
    tabs: record.session.tabs.map((tab) => ({ ...tab })),
    allowedOrigins: [...record.session.allowedOrigins],
  };
}

export function createBrowserService(deps: BrowserServiceDeps): BrowserService {
  const store = deps.store;
  const consumedApprovals = new Set<string>();
  const pendingCreates = new Map<string, number>();
  const sessionQueues = new Map<string, Promise<void>>();
  let closing = false;

  async function serialize<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => {}, () => {});
    sessionQueues.set(sessionId, tail);
    try {
      return await result;
    } finally {
      if (sessionQueues.get(sessionId) === tail) sessionQueues.delete(sessionId);
    }
  }

  function serialized<Args extends unknown[], T>(
    operation: (ownerId: string, sessionId: string, ...args: Args) => Promise<T>,
  ): typeof operation {
    return (ownerId, sessionId, ...args) =>
      serialize(sessionId, () => operation(ownerId, sessionId, ...args));
  }

  function reserveCreate(ownerId: string): void {
    pendingCreates.set(ownerId, (pendingCreates.get(ownerId) ?? 0) + 1);
  }

  function releaseCreate(ownerId: string): void {
    const remaining = (pendingCreates.get(ownerId) ?? 1) - 1;
    if (remaining <= 0) pendingCreates.delete(ownerId);
    else pendingCreates.set(ownerId, remaining);
  }

  function nowMs(): number {
    return deps.clock.now().getTime();
  }

  function limits(): BrowserLimits {
    return limitsFor(deps.config);
  }

  function audit(
    ownerId: string,
    action: string,
    outcome: AuditOutcome,
    detail?: string,
  ): void {
    deps.audit.record({
      actor: ownerId,
      action,
      outcome,
      ...(detail ? { detail: redactText(detail, [], 300) } : {}),
    });
  }

  function addReceipt(input: {
    record: StoredBrowserSession;
    action: BrowserReceiptAction;
    outcome: 'succeeded' | 'refused' | 'failed';
    started: number;
    approvalId?: string;
    artifactId?: string;
    detail?: string;
  }): BrowserReceipt {
    const receipt: BrowserReceipt = {
      receiptId: deps.ids.receipt(),
      sessionId: input.record.session.sessionId,
      action: input.action,
      outcome: input.outcome,
      provider: input.record.session.provider,
      at: deps.clock.iso(),
      durationMs: Math.max(0, nowMs() - input.started),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      ...(input.detail ? { detail: redactText(input.detail, [], 500) } : {}),
    };
    store.addReceipt({ ownerId: input.record.ownerId, receipt });
    return receipt;
  }

  function refusal(
    record: StoredBrowserSession,
    action: BrowserReceiptAction,
    code: ProblemCode,
    detail: string,
    started: number,
  ): ServiceFailure {
    addReceipt({ record, action, outcome: 'refused', started, detail });
    audit(record.ownerId, 'browser.action.refused', 'refused', `action=${action}`);
    return fail(code, detail);
  }

  function providerFailure(failure: ProviderFailure): ServiceFailure {
    const detail = redactText(failure.detail, [], 500);
    switch (failure.code) {
      case 'not_configured':
      case 'unsupported':
        return fail('engine_not_configured', detail);
      case 'forbidden':
        return fail('forbidden', detail);
      case 'protocol_error':
        return fail('protocol_error', detail);
      case 'timeout':
        return fail('browser_unavailable', detail, true);
      default:
        return fail('browser_unavailable', detail, true);
    }
  }

  function capabilityFailure(capabilities: BrowserCapabilities): ServiceFailure {
    const code: ProblemCode =
      capabilities.reason === 'protocol_error'
        ? 'protocol_error'
        : capabilities.reason === 'unreachable'
          ? 'browser_unavailable'
          : 'engine_not_configured';
    return fail(code, capabilities.detail, capabilities.reason === 'unreachable');
  }

  async function closeProvider(record: StoredBrowserSession): Promise<boolean> {
    try {
      const result = await deps.provider.close(record.providerSessionId);
      return result.ok;
    } catch {
      // An unreachable provider cannot confirm termination. The caller records
      // the session as quarantined rather than inventing a clean close.
      return false;
    }
  }

  async function expireIfNeeded(record: StoredBrowserSession): Promise<void> {
    if (TERMINAL_STATES.has(record.session.state)) return;
    if (nowMs() < Date.parse(record.session.expiresAt)) return;
    const released = await closeProvider(record);
    record.session = {
      ...record.session,
      state: released ? 'expired' : 'quarantined',
      updatedAt: deps.clock.iso(),
      ...(released
        ? {
            failure: {
              code: 'timeout',
              detail: 'The cloud browser session reached its configured expiry.',
            },
          }
        : {
            failure: {
              code: 'browser_unavailable',
              detail:
                'The session expired, but the provider did not confirm remote termination; it is quarantined.',
            },
          }),
    };
    store.updateSession(record);
    addReceipt({
      record,
      action: 'close',
      outcome: 'failed',
      started: nowMs(),
      detail: released
        ? 'The session expired and its cloud browser was released.'
        : 'The session expired and remote termination was not confirmed; it is quarantined.',
    });
    audit(record.ownerId, 'browser.session.expired', 'failed', released ? 'expiry' : 'quarantine');
  }

  async function sweep(ownerId: string): Promise<void> {
    for (const record of store.sessions(ownerId)) {
      await serialize(record.session.sessionId, () => expireIfNeeded(record));
    }
  }

  async function owned(
    ownerId: string,
    sessionId: string,
  ): Promise<ServiceResult<StoredBrowserSession>> {
    const record = store.session(ownerId, sessionId);
    if (!record) return fail('not_found', 'That browser session does not exist for this owner.');
    await expireIfNeeded(record);
    return ok(record);
  }

  function storeArtifact(
    record: StoredBrowserSession,
    kind: BrowserArtifact['kind'],
    contentType: string,
    data: Buffer,
  ): BrowserArtifact {
    const artifact: BrowserArtifact = {
      artifactId: deps.ids.browserArtifactId(),
      sessionId: record.session.sessionId,
      kind,
      contentType,
      bytes: data.length,
      digest: digestOf(data),
      createdAt: deps.clock.iso(),
    };
    store.addArtifact({ ownerId: record.ownerId, artifact, data });
    return artifact;
  }

  async function protocolViolation(
    record: StoredBrowserSession,
    action: BrowserReceiptAction,
    detail: string,
    started: number,
    approvalId?: string,
  ): Promise<ServiceFailure> {
    const released = await closeProvider(record);
    record.session = {
      ...record.session,
      state: released ? 'failed' : 'quarantined',
      updatedAt: deps.clock.iso(),
      failure: {
        code: released ? 'protocol_error' : 'browser_unavailable',
        detail: released
          ? detail
          : `${detail} Remote termination was not confirmed; the session is quarantined.`,
      },
    };
    store.updateSession(record);
    addReceipt({ record, action, outcome: 'failed', started, detail, ...(approvalId ? { approvalId } : {}) });
    audit(record.ownerId, 'browser.action.failed', 'failed', `action=${action}`);
    return fail('protocol_error', detail);
  }

  async function checkApproval(input: {
    record: StoredBrowserSession;
    category: BrowserSensitiveCategory;
    scope: PermissionRequest['scope'];
    approvalId: string | undefined;
    action: BrowserReceiptAction;
    started: number;
  }): Promise<ServiceResult<{ approvalId: string }>> {
    const { record, category, scope, approvalId, action, started } = input;
    const resource = resourceFor(record.session.sessionId, category);
    if (!approvalId) {
      return refusal(
        record,
        action,
        'permission_required',
        `Owner approval is required for a ${category.replace(/_/g, ' ')} action. Request one through POST /v1/browser/sessions/${record.session.sessionId}/authorize and pass its id as approvalId.`,
        started,
      );
    }

    const request = await deps.permissions.get(
      record.ownerId,
      record.session.sessionId,
      approvalId,
    );
    const key = `${record.ownerId}:${record.session.sessionId}:${approvalId}`;
    const valid =
      request !== null &&
      request.decision === 'approved' &&
      request.scope === scope &&
      request.resource === resource &&
      Date.parse(request.expiresAt) > nowMs();
    if (!valid) {
      return refusal(
        record,
        action,
        'permission_required',
        'That approval is not valid for this session and action.',
        started,
      );
    }
    if (consumedApprovals.has(key)) {
      return refusal(
        record,
        action,
        'permission_required',
        'That approval has already been used; request a new one.',
        started,
      );
    }
    // Single-use: consumed before dispatch, so a provider failure cannot replay it.
    consumedApprovals.add(key);
    return ok({ approvalId });
  }

  const service: BrowserService = {
    capabilities: async () => {
      try {
        const reported = await deps.provider.describe();
        // Report the limits this engine actually enforces, not a provider's
        // more generous claim.
        const enforced = limits();
        return {
          ...reported,
          limits: {
            maxSessionTtlSeconds: Math.min(
              reported.limits.maxSessionTtlSeconds,
              enforced.maxSessionTtlSeconds,
            ),
            maxSessionsPerOwner: enforced.maxSessionsPerOwner,
            maxScreenshotBytes: Math.min(
              reported.limits.maxScreenshotBytes,
              enforced.maxScreenshotBytes,
            ),
            maxUploadBytes: Math.min(
              reported.limits.maxUploadBytes,
              enforced.maxUploadBytes,
            ),
          },
        };
      } catch {
        return unavailableCapabilities({
          provider: deps.provider.kind,
          reason: 'protocol_error',
          detail: 'The browser provider capability check failed.',
          limits: limits(),
        });
      }
    },

    list: async (ownerId) => {
      await sweep(ownerId);
      return {
        sessions: store
          .sessions(ownerId)
          .map(toContract)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      };
    },

    get: async (ownerId, sessionId) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      return ok(toContract(found.value));
    },

    create: async (ownerId, request) => {
      if (closing) {
        return fail('conflict', 'The browser service is shutting down.');
      }
      const origins = normalizeOrigins(request.origins);
      if (!origins) {
        return fail(
          'validation_failed',
          'Each origin must be an absolute http(s) origin without credentials, a path, a query or a fragment.',
        );
      }

      const capabilities = await service.capabilities();
      if (!capabilities.operational) {
        audit(ownerId, 'browser.session.create', 'refused', capabilities.reason);
        return capabilityFailure(capabilities);
      }

      await sweep(ownerId);
      if (closing) {
        return fail('conflict', 'The browser service is shutting down.');
      }
      const live = store.sessions(ownerId).filter(
        (record) => isLive(record.session) || record.session.state === 'quarantined',
      );
      const pending = pendingCreates.get(ownerId) ?? 0;
      if (live.length + pending >= deps.config.browsers.maxSessionsPerOwner) {
        return fail(
          'conflict',
          'The owner already has the maximum number of live browser sessions.',
        );
      }

      const configuredTtl = Math.floor(deps.config.browsers.sessionTtlMs / 1000);
      // The provider handshake may advertise a shorter maximum than the engine
      // configuration. Never report a session live past the remote TTL.
      const ttlSeconds = Math.min(
        request.ttlSeconds ?? configuredTtl,
        configuredTtl,
        capabilities.limits.maxSessionTtlSeconds,
      );
      const started = nowMs();
      reserveCreate(ownerId);
      try {
        const created = await deps.provider.create({
          ttlSeconds,
          allowedOrigins: origins,
          label: request.label,
          purpose: request.purpose,
          ...(request.viewport ? { viewport: request.viewport } : {}),
        });
        if (!created.ok) {
          audit(ownerId, 'browser.session.create', 'failed', created.detail);
          return providerFailure(created);
        }
        if (closing) {
          try {
            await deps.provider.close(created.value.providerSessionId);
          } catch {
            // Shutdown is already in progress; never store a session now.
          }
          audit(ownerId, 'browser.session.create', 'refused', 'shutdown');
          return fail('conflict', 'The browser service is shutting down.');
        }

        const url = sanitizePageUrl(created.value.url);
        const tabs = sanitizeTabs(created.value.tabs);
        const usable =
          url !== null &&
          (url === 'about:blank' || originAllowed(url, origins)) &&
          tabs !== null &&
          tabsWithinOrigins(tabs, origins);
        const now = deps.clock.iso();
        const session: BrowserSession = {
          sessionId: deps.ids.browserSessionId(),
          label: request.label,
          purpose: request.purpose,
          state: usable ? 'ready' : 'quarantined',
          environment: 'cloud',
          provider: deps.provider.kind,
          url: usable ? url : 'about:blank',
          title: usable ? sanitizeLabel(created.value.title, 300) : '',
          tabs: usable && tabs ? tabs : [],
          allowedOrigins: origins,
          createdAt: now,
          updatedAt: now,
          // The provider's TTL starts at creation, so anchoring here is earlier
          // than the provider's own expiry and can never keep a dead session.
          expiresAt: new Date(started + ttlSeconds * 1000).toISOString(),
        };
        const record: StoredBrowserSession = {
          ownerId,
          providerSessionId: created.value.providerSessionId,
          session,
          lastElements: [],
        };
        store.putSession(record);
        if (!usable) {
          return await serialize(session.sessionId, () =>
            protocolViolation(
              record,
              'session.create',
              'The browser provider returned an unusable page or tab outside the allowlist.',
              started,
            ),
          );
        }
        addReceipt({ record, action: 'session.create', outcome: 'succeeded', started });
        audit(ownerId, 'browser.session.created', 'accepted', 'provider');
        return ok(toContract(record));
      } finally {
        releaseCreate(ownerId);
      }
    },

    act: async (ownerId, sessionId, action) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      const started = nowMs();
      const actionName = action.type as BrowserReceiptAction;
      const state = record.session.state;

      if (state === 'closed') {
        return refusal(record, actionName, 'conflict', 'The browser session is closed.', started);
      }
      if (state === 'expired') {
        return refusal(record, actionName, 'conflict', 'The browser session has expired.', started);
      }
      if (state === 'failed') {
        return refusal(
          record,
          actionName,
          'browser_unavailable',
          record.session.failure?.detail ?? 'The browser session failed and cannot be used.',
          started,
        );
      }
      if (state === 'quarantined') {
        return refusal(
          record,
          actionName,
          'browser_unavailable',
          'Remote termination was not confirmed; this session is quarantined and cannot be used.',
          started,
        );
      }
      if (state === 'paused') {
        return refusal(
          record,
          actionName,
          'conflict',
          'The browser session is paused; resume it before acting.',
          started,
        );
      }
      if (state === 'owner_controlled') {
        return refusal(
          record,
          actionName,
          'forbidden',
          'The owner has control of this session; release it before the agent acts.',
          started,
        );
      }

      if (action.type === 'tab' && action.input === 'open' && !action.url) {
        return refusal(record, actionName, 'validation_failed', 'Opening a tab requires a URL.', started);
      }
      if (
        action.type === 'tab' &&
        (action.input === 'close' || action.input === 'activate') &&
        !action.tabId
      ) {
        return refusal(record, actionName, 'validation_failed', `${action.input} requires a tab id.`, started);
      }

      let normalizedAction: BrowserAction = action;
      if (action.type === 'navigate') {
        const safe = sanitizePageUrl(action.url, { allowAboutBlank: false });
        if (!safe || !originAllowed(safe, record.session.allowedOrigins)) {
          return refusal(
            record,
            actionName,
            'forbidden',
            'Navigation is confined to the session origin allowlist.',
            started,
          );
        }
        normalizedAction = { ...action, url: safe };
      }
      if (action.type === 'tab' && action.input === 'open' && action.url) {
        const safe = sanitizePageUrl(action.url, { allowAboutBlank: false });
        if (!safe || !originAllowed(safe, record.session.allowedOrigins)) {
          return refusal(
            record,
            actionName,
            'forbidden',
            'Opening a tab is confined to the session origin allowlist.',
            started,
          );
        }
        normalizedAction = { ...action, url: safe };
      }

      let uploadData: Buffer | undefined;
      if (action.type === 'upload') {
        const filename = sanitizeFilename(action.filename);
        if (!filename) {
          return refusal(record, actionName, 'validation_failed', 'The upload filename is not usable.', started);
        }
        const decoded = decodeBase64(action.dataBase64, deps.config.browsers.maxUploadBytes);
        if (!decoded) {
          return refusal(
            record,
            actionName,
            'validation_failed',
            'The upload must be canonical base64 within the configured size limit.',
            started,
          );
        }
        uploadData = decoded;
        // The provider never receives a path-shaped or control-filled name.
        normalizedAction = { ...action, filename };
      }

      const targetElementId =
        'target' in action && action.target ? action.target.elementId : undefined;
      if (
        targetElementId &&
        !record.lastElements.some((element) => element.elementId === targetElementId)
      ) {
        return refusal(
          record,
          actionName,
          'validation_failed',
          'The target element has not been observed; inspect the page and use an element id from that observation.',
          started,
        );
      }
      const targetElement =
        targetElementId === undefined
          ? undefined
          : record.lastElements.find((element) => element.elementId === targetElementId);
      const passwordTarget =
        action.type === 'fill' &&
        targetElement?.inputType?.toLowerCase() === 'password';

      const sensitivity = sensitivityFor(normalizedAction, {
        passwordTarget,
        ...(targetElement ? { targetRole: targetElement.role } : {}),
      });
      let approvalId: string | undefined;
      if (sensitivity) {
        const approval = await checkApproval({
          record,
          category: sensitivity.category,
          scope: sensitivity.scope,
          approvalId: 'approvalId' in action ? action.approvalId : undefined,
          action: actionName,
          started,
        });
        if (!approval.ok) return approval;
        approvalId = approval.value.approvalId;
      }

      const outcome = await deps.provider.act({
        providerSessionId: record.providerSessionId,
        action: normalizedAction,
        allowedOrigins: record.session.allowedOrigins,
      });
      if (!outcome.ok) {
        if (outcome.outcomeUnknown) {
          record.lastElements = [];
          return protocolViolation(
            record,
            actionName,
            'The browser action outcome is unknown; the provider did not confirm its result.',
            started,
            approvalId,
          );
        }
        addReceipt({
          record,
          action: actionName,
          outcome: 'failed',
          started,
          ...(approvalId ? { approvalId } : {}),
          detail: outcome.detail,
        });
        audit(record.ownerId, 'browser.action.failed', 'failed', `action=${actionName}`);
        return providerFailure(outcome);
      }

      const url = sanitizePageUrl(outcome.value.url);
      if (!url || (url !== 'about:blank' && !originAllowed(url, record.session.allowedOrigins))) {
        return protocolViolation(
          record,
          actionName,
          'The browser provider returned a page outside the session allowlist.',
          started,
        );
      }
      const tabs = sanitizeTabs(outcome.value.tabs ?? record.session.tabs);
      if (!tabs || !tabsWithinOrigins(tabs, record.session.allowedOrigins)) {
        return protocolViolation(
          record,
          actionName,
          'The browser provider returned an unusable or out-of-allowlist tab list.',
          started,
        );
      }

      let artifact: BrowserArtifact | undefined;
      const artifacts = outcome.value.artifacts ?? [];
      if (action.type === 'screenshot') {
        const screenshot = artifacts.length === 1 ? artifacts[0] : undefined;
        if (
          !screenshot ||
          screenshot.kind !== 'screenshot' ||
          screenshot.data.length > deps.config.browsers.maxScreenshotBytes ||
          !matchesImageType(screenshot.contentType, screenshot.data)
        ) {
          return protocolViolation(
            record,
            actionName,
            'A screenshot action must return exactly one PNG or JPEG image within the configured limit.',
            started,
          );
        }
        const detected = detectImageType(screenshot.data);
        artifact = storeArtifact(
          record,
          'screenshot',
          detected ?? screenshot.contentType,
          screenshot.data,
        );
      } else if (action.type === 'download') {
        const download = artifacts.length === 1 ? artifacts[0] : undefined;
        if (
          !download ||
          download.kind !== 'download' ||
          download.data.length > deps.config.browsers.maxUploadBytes ||
          !isSafeTransferType(download.contentType)
        ) {
          return protocolViolation(
            record,
            actionName,
            'A download action must return exactly one safe file within the configured limit.',
            started,
          );
        }
        artifact = storeArtifact(
          record,
          'download',
          download.contentType.toLowerCase().split(';')[0]?.trim() ?? download.contentType,
          download.data,
        );
      } else if (action.type === 'upload') {
        if (artifacts.length > 0 || !uploadData) {
          return protocolViolation(
            record,
            actionName,
            'An upload action must not return provider artifacts.',
            started,
          );
        }
        artifact = storeArtifact(record, 'upload', action.contentType, uploadData);
      } else if (artifacts.length > 0) {
        return protocolViolation(
          record,
          actionName,
          'The browser provider returned an artifact the action did not request.',
          started,
        );
      }

      const title = sanitizeLabel(outcome.value.title, 300);
      let observation: BrowserObservation | undefined;
      let observedElements: BrowserElement[] | undefined;
      if (
        action.type === 'inspect' ||
        action.type === 'find' ||
        (action.type === 'tab' && action.input === 'list')
      ) {
        const providerObservation = outcome.value.observation;
        if (!providerObservation && action.type !== 'tab') {
          return protocolViolation(
            record,
            actionName,
            'The browser provider did not return the observation the action requested.',
            started,
          );
        }
        const maxText = action.type === 'inspect' ? action.maxTextChars : 20_000;
        const rawText = providerObservation?.text;
        const text = rawText === undefined ? undefined : sanitizeUntrusted(rawText, maxText);
        const allElements = sanitizeElements(providerObservation?.elements ?? []);
        const elements =
          action.type === 'tab'
            ? []
            : action.type === 'inspect' && action.includeElements === false
              ? []
              : action.type === 'find'
                ? allElements.slice(0, action.limit)
                : allElements;
        const truncated =
          providerObservation?.truncated === true ||
          (rawText?.length ?? 0) > maxText ||
          (providerObservation?.elements?.length ?? 0) > 200 ||
          (action.type !== 'inspect' || action.includeElements) &&
            allElements.length > elements.length;
        observation = {
          url,
          title,
          ...(text !== undefined ? { text } : {}),
          elements,
          tabs,
          trust: 'untrusted',
          truncated,
        };
        observedElements = elements;
      }

      const previousUrl = record.session.url;
      const previousActiveTab = record.session.tabs.find((tab) => tab.active)?.tabId;
      const activeTab = tabs.find((tab) => tab.active)?.tabId;
      record.session = {
        ...record.session,
        url,
        title,
        tabs,
        updatedAt: deps.clock.iso(),
      };
      if (observedElements !== undefined) {
        record.lastElements = observedElements;
      } else if (url !== previousUrl || activeTab !== previousActiveTab) {
        // A click, key or tab close can change the document even when the
        // action did not name a navigation. Old element ids are not targets.
        record.lastElements = [];
      }
      store.updateSession(record);

      const receipt = addReceipt({
        record,
        action: actionName,
        outcome: 'succeeded',
        started,
        ...(approvalId ? { approvalId } : {}),
        ...(artifact ? { artifactId: artifact.artifactId } : {}),
      });
      audit(record.ownerId, 'browser.action.succeeded', 'completed', `action=${actionName}`);
      return ok({
        sessionId: record.session.sessionId,
        receiptId: receipt.receiptId,
        action: action.type,
        state: record.session.state,
        ...(observation ? { observation } : {}),
        ...(artifact ? { artifact } : {}),
        at: deps.clock.iso(),
      });
    },

    pause: async (ownerId, sessionId) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      const started = nowMs();
      if (record.session.state !== 'ready') {
        return refusal(
          record,
          'pause',
          'conflict',
          'Only a ready browser session can be paused.',
          started,
        );
      }
      const result = await deps.provider.pause(record.providerSessionId);
      if (!result.ok) {
        addReceipt({ record, action: 'pause', outcome: 'failed', started, detail: result.detail });
        return providerFailure(result);
      }
      record.session = { ...record.session, state: 'paused', updatedAt: deps.clock.iso() };
      store.updateSession(record);
      addReceipt({ record, action: 'pause', outcome: 'succeeded', started });
      audit(ownerId, 'browser.session.paused', 'completed');
      return ok(toContract(record));
    },

    resume: async (ownerId, sessionId) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      const started = nowMs();
      if (record.session.state !== 'paused') {
        return refusal(
          record,
          'resume',
          'conflict',
          'Only a paused browser session can be resumed.',
          started,
        );
      }
      const result = await deps.provider.resume(record.providerSessionId);
      if (!result.ok) {
        addReceipt({ record, action: 'resume', outcome: 'failed', started, detail: result.detail });
        return providerFailure(result);
      }
      record.session = { ...record.session, state: 'ready', updatedAt: deps.clock.iso() };
      store.updateSession(record);
      addReceipt({ record, action: 'resume', outcome: 'succeeded', started });
      audit(ownerId, 'browser.session.resumed', 'completed');
      return ok(toContract(record));
    },

    takeover: async (ownerId, sessionId, request) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      const started = nowMs();

      if (request.active) {
        if (record.session.state !== 'ready') {
          return refusal(
            record,
            'takeover',
            'conflict',
            'Only a ready browser session can be taken over.',
            started,
          );
        }
        const result = await deps.provider.takeover(record.providerSessionId);
        if (!result.ok) {
          addReceipt({ record, action: 'takeover', outcome: 'failed', started, detail: result.detail });
          return providerFailure(result);
        }
        const interactiveUrl = sanitizePageUrl(result.value.interactiveUrl, {
          allowAboutBlank: false,
        });
        const liveView = interactiveUrl ? new URL(interactiveUrl) : null;
        if (!liveView || (
          liveView.protocol !== 'https:' &&
          !['localhost', '127.0.0.1', '[::1]'].includes(liveView.hostname)
        )) {
          return protocolViolation(
            record,
            'takeover',
            'The browser provider returned an unusable interactive session URL.',
            started,
          );
        }
        record.session = {
          ...record.session,
          state: 'owner_controlled',
          updatedAt: deps.clock.iso(),
        };
        store.updateSession(record);
        addReceipt({ record, action: 'takeover', outcome: 'succeeded', started });
        audit(ownerId, 'browser.session.takeover', 'accepted');
        // The live-view URL is returned once; it is never persisted or audited.
        return ok({ session: toContract(record), interactiveUrl: liveView.href });
      }

      if (record.session.state !== 'owner_controlled') {
        return refusal(
          record,
          'release',
          'conflict',
          'The owner does not control this browser session.',
          started,
        );
      }
      const result = await deps.provider.release(record.providerSessionId);
      if (!result.ok) {
        addReceipt({ record, action: 'release', outcome: 'failed', started, detail: result.detail });
        return providerFailure(result);
      }
      record.session = { ...record.session, state: 'ready', updatedAt: deps.clock.iso() };
      store.updateSession(record);
      addReceipt({ record, action: 'release', outcome: 'succeeded', started });
      audit(ownerId, 'browser.session.released', 'completed');
      return ok({ session: toContract(record) });
    },

    close: async (ownerId, sessionId, request) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      if (record.session.state === 'closed') {
        return ok(toContract(record));
      }

      const started = nowMs();
      const released = await closeProvider(record);
      const now = deps.clock.iso();
      record.session = {
        ...record.session,
        state: released ? 'closed' : 'quarantined',
        updatedAt: now,
        closedAt: now,
        ...(released
          ? {}
          : {
              failure: {
                code: 'browser_unavailable',
                detail:
                  'The provider did not confirm remote termination; the session is quarantined.',
              },
            }),
      };
      store.updateSession(record);
      const closeDetail = released
        ? request.reason
        : `${request.reason ? `${request.reason} ` : ''}Remote termination was not confirmed; the session is quarantined.`;
      addReceipt({
        record,
        action: 'close',
        outcome: released ? 'succeeded' : 'failed',
        started,
        ...(closeDetail ? { detail: closeDetail } : {}),
      });
      audit(ownerId, 'browser.session.closed', released ? 'cancelled' : 'failed');
      return ok(toContract(record));
    },

    authorize: async (ownerId, sessionId, request) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const record = found.value;
      if (TERMINAL_STATES.has(record.session.state)) {
        return fail('conflict', 'A closed, expired or failed session cannot be authorized.');
      }
      const scope = scopeFor(request.category);
      const resource = resourceFor(record.session.sessionId, request.category);
      const permission = await deps.permissions.request({
        ownerId,
        taskId: record.session.sessionId,
        agent: 'coderax',
        scope,
        resource,
        description: `Browser ${request.category.replace(/_/g, ' ')} action on session ${record.session.sessionId}: ${request.description}`.slice(
          0,
          2000,
        ),
        ttlMs: APPROVAL_TTL_MS,
      });
      audit(ownerId, 'browser.authorization.requested', 'accepted', `category=${request.category}`);
      return ok(permission);
    },

    decide: async (ownerId, sessionId, request) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      const result = await deps.permissions.decide({
        ownerId,
        taskId: sessionId,
        requestId: request.requestId,
        decision: request.decision,
        ...(request.reason ? { reason: request.reason } : {}),
      });
      if (result.ok) {
        audit(ownerId, 'browser.authorization.decided', 'accepted', request.decision);
      }
      return result;
    },

    receipts: async (ownerId, sessionId) => {
      const found = await owned(ownerId, sessionId);
      if (!found.ok) return found;
      return ok({ receipts: store.receipts(ownerId, sessionId) });
    },

    artifact: async (ownerId, artifactId) => {
      const stored = store.artifact(ownerId, artifactId);
      if (!stored) {
        return fail('not_found', 'That browser artifact does not exist or has been evicted.');
      }
      return ok({ artifact: stored.artifact, dataBase64: stored.data.toString('base64') });
    },

    shutdown: async () => {
      closing = true;
      for (const record of store.liveSessions()) {
        await serialize(record.session.sessionId, async () => {
          if (!isLive(record.session)) return;
          const released = await closeProvider(record);
          const now = deps.clock.iso();
          record.session = {
            ...record.session,
            state: released ? 'closed' : 'quarantined',
            updatedAt: now,
            closedAt: now,
            ...(released
              ? {}
              : {
                  failure: {
                    code: 'browser_unavailable',
                    detail:
                      'Shutdown could not confirm remote termination; the session is quarantined.',
                  },
                }),
          };
          store.updateSession(record);
          addReceipt({
            record,
            action: 'close',
            outcome: released ? 'succeeded' : 'failed',
            started: nowMs(),
            detail: released
              ? 'Shutdown released the cloud browser.'
              : 'Shutdown could not confirm remote termination; the session is quarantined.',
          });
        });
      }
    },
  };

  return {
    ...service,
    get: serialized(service.get),
    act: serialized(service.act),
    pause: serialized(service.pause),
    resume: serialized(service.resume),
    takeover: serialized(service.takeover),
    close: serialized(service.close),
    authorize: serialized(service.authorize),
    decide: serialized(service.decide),
    receipts: serialized(service.receipts),
  };
}
