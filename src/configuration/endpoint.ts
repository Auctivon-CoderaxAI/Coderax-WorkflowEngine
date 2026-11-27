import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * A credential may only cross the network inside TLS.
 *
 * The endpoint is configuration, not a request, so this is a startup gate rather
 * than a runtime check. Plaintext is accepted only for a loopback address, where
 * no network is traversed. A URL that embeds a credential (userinfo or a known
 * query parameter) is refused even over TLS: it would be copied into logs,
 * metrics and provider error text by every layer that prints a URL.
 */

const CREDENTIAL_PARAM =
  /^(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|key|password|passwd|secret|sig|signature|token)$/i;

function withoutBrackets(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

export function isLoopbackHost(hostname: string): boolean {
  const host = withoutBrackets(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function validateRemoteEndpoint(input: {
  url: string;
  /** Configuration field name; never the URL itself in the failure text. */
  name: string;
  /** True when a secret header or query parameter will accompany the request. */
  carriesCredential: boolean;
}): ServiceResult<string> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail('engine_not_configured', `${input.name} must be an absolute http(s) URL.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail('engine_not_configured', `${input.name} must use http or https.`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return fail(
      'engine_not_configured',
      `${input.name} must not embed a credential in the URL; name it by environment variable instead.`,
    );
  }
  for (const key of parsed.searchParams.keys()) {
    if (CREDENTIAL_PARAM.test(key)) {
      return fail(
        'engine_not_configured',
        `${input.name} must not carry a credential in its query string; name it by environment variable instead.`,
      );
    }
  }
  if (
    input.carriesCredential &&
    parsed.protocol === 'http:' &&
    !isLoopbackHost(parsed.hostname)
  ) {
    return fail(
      'engine_not_configured',
      `${input.name} would send a credential over plaintext to a remote host; use https or a loopback endpoint.`,
    );
  }

  return ok(parsed.toString());
}
