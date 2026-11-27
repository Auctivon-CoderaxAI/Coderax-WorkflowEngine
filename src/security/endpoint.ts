import { isIPv4 } from 'node:net';

/**
 * Inference endpoints are the one place a credential is sent on purpose.
 *
 * Two rules are enforced here rather than trusted to each adapter:
 *
 * 1. A remote endpoint must be `https`. A bearer key, a Basic password or an
 *    `x-goog-api-key` sent over `http` is a credential in cleartext on the wire,
 *    and a loopback service is the only case where there is no wire.
 * 2. A credential never rides in the URL. A `user:password@host` or a `?key=`
 *    ends up in a log line, an error message and a process listing.
 *
 * `local` means the endpoint is on this machine. It is derived from the parsed
 * URL, never from a caller-supplied label, so a remote host cannot claim to be
 * local and receive private data.
 */

export type ProviderHosting = 'local' | 'hosted';

export type EndpointVerdict =
  | { ok: true; hosting: ProviderHosting }
  | { ok: false; reason: string };

/** Loopback only: no private ranges, because those still cross a network. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (isIPv4(host)) return host.startsWith('127.');
  return false;
}

export function classifyEndpoint(raw: string): EndpointVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'must be an absolute URL' };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'must not embed credentials' };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return { ok: false, reason: 'must not carry a query or fragment' };
  }
  const local = isLoopbackHostname(url.hostname);
  if (url.protocol === 'https:') {
    return { ok: true, hosting: local ? 'local' : 'hosted' };
  }
  if (url.protocol === 'http:') {
    if (!local) {
      return { ok: false, reason: 'must use https unless the host is loopback' };
    }
    return { ok: true, hosting: 'local' };
  }
  return { ok: false, reason: 'must use http or https' };
}

/** The reason a configured endpoint is refused, or null when it is acceptable. */
export function endpointIssue(raw: string): string | null {
  const verdict = classifyEndpoint(raw);
  return verdict.ok ? null : verdict.reason;
}

/**
 * Parse a credential-bearing endpoint for an outbound call. It applies the same
 * rule as configuration validation, so a runtime endpoint cannot be weaker than
 * a configured one.
 */
export function credentialEndpoint(value: string): URL {
  const verdict = classifyEndpoint(value);
  if (!verdict.ok) {
    throw new Error(
      verdict.reason === 'must use https unless the host is loopback'
        ? 'Remote credential endpoints require HTTPS.'
        : `Invalid credential endpoint: ${verdict.reason}.`,
    );
  }
  return new URL(value);
}
