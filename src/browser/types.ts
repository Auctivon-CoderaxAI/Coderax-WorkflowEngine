import type {
  BrowserAction,
  BrowserArtifactKind,
  BrowserCapabilities,
  BrowserLimits,
  BrowserPurpose,
  BrowserTab,
  BrowserViewport,
} from '@coderax/contracts';

/**
 * The browser provider port.
 *
 * A provider is remote, owner-authorized and zero-cost. It receives no owner
 * credential beyond its own token, no task state and no approval records: the
 * engine decides what is allowed, the provider only performs the action. Every
 * result is raw evidence; the engine sanitizes it and never trusts it as an
 * instruction.
 */

export type ProviderFailureCode =
  | 'not_configured'
  | 'unavailable'
  | 'timeout'
  | 'protocol_error'
  | 'forbidden'
  | 'unsupported';

export type ProviderFailure = {
  ok: false;
  code: ProviderFailureCode;
  /** The request may have taken effect, but its outcome could not be verified. */
  outcomeUnknown?: true;
  /** User-safe text: no credential, upstream body, stack or owner path. */
  detail: string;
};

export type ProviderResult<T> = { ok: true; value: T } | ProviderFailure;

export type ProviderElement = {
  elementId: string;
  role: string;
  name: string;
  value?: string;
  inputType?: string;
  disabled?: boolean;
  focused?: boolean;
};

export type ProviderObservation = {
  text?: string;
  elements?: ProviderElement[];
  truncated?: boolean;
};

export type ProviderArtifact = {
  kind: BrowserArtifactKind;
  contentType: string;
  data: Buffer;
};

export type ProviderSession = {
  providerSessionId: string;
  url: string;
  title: string;
  tabs: BrowserTab[];
};

export type ProviderActionOutcome = {
  url: string;
  title: string;
  tabs?: BrowserTab[];
  observation?: ProviderObservation;
  artifacts?: ProviderArtifact[];
};

export type ProviderCreateInput = {
  ttlSeconds: number;
  allowedOrigins: string[];
  label: string;
  purpose: BrowserPurpose;
  viewport?: BrowserViewport;
};

export type ProviderActInput = {
  providerSessionId: string;
  action: BrowserAction;
  allowedOrigins: string[];
};

export type BrowserProvider = {
  readonly kind: string;
  /** A truthful capability report; never cached beyond a bounded freshness window. */
  describe: () => Promise<BrowserCapabilities>;
  create: (input: ProviderCreateInput) => Promise<ProviderResult<ProviderSession>>;
  act: (input: ProviderActInput) => Promise<ProviderResult<ProviderActionOutcome>>;
  pause: (providerSessionId: string) => Promise<ProviderResult<void>>;
  resume: (providerSessionId: string) => Promise<ProviderResult<void>>;
  takeover: (
    providerSessionId: string,
  ) => Promise<ProviderResult<{ interactiveUrl: string }>>;
  release: (providerSessionId: string) => Promise<ProviderResult<void>>;
  close: (providerSessionId: string) => Promise<ProviderResult<void>>;
};

export type { BrowserLimits };
