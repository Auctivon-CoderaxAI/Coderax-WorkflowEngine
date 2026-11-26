import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Outbound network policy.
 *
 * A hostname allowlist alone is not SSRF protection: an allow-listed name can
 * resolve to a link-local metadata service, a loopback admin port or a private
 * network, and a redirect can move the request there after the check. This
 * module therefore validates the scheme, resolves the destination, refuses every
 * non-public address, and pins the resolved address into the TLS request so the
 * connection cannot be redirected by a second DNS answer. Redirects are not
 * followed at all; a caller that needs one must ask again through this policy.
 */

export type DestinationPolicy = {
  /** Hostnames (or `.suffix` entries) the owner approved. */
  allowedHosts: string[];
  /** Only loopback development endpoints may opt into plaintext HTTP. */
  allowInsecureLoopback?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
};

export type NetworkFailure =
  | { code: 'blocked'; detail: string }
  | { code: 'failed'; detail: string };

export type NetworkResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  /** True when the body exceeded the configured bound and was truncated. */
  truncated: boolean;
};

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Every address range that is not globally routable. IPv4-mapped IPv6 is
 * normalized first so `::ffff:127.0.0.1` cannot bypass the IPv4 checks.
 */
export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address;
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map((piece) => Number(piece));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    if (normalized.startsWith('ff')) return false;
    return true;
  }
  return false;
}

export function hostAllowed(hostname: string, allowedHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    if (allowed.startsWith('.')) return host.endsWith(allowed);
    return host === allowed;
  });
}

export type ParsedTarget = { url: URL; addresses: string[] };

/**
 * Parses and authorizes a URL without dispatching anything. `https` is required
 * except for an explicitly permitted loopback development target, credentials in
 * the URL are refused, and every resolved address must be public.
 */
export async function authorizeUrl(
  raw: string,
  policy: DestinationPolicy,
): Promise<{ ok: true; target: ParsedTarget } | { ok: false; detail: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: 'That URL is not valid.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, detail: 'Only HTTP(S) URLs are allowed.' };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, detail: 'A URL may not carry credentials.' };
  }
  if (!hostAllowed(url.hostname, policy.allowedHosts)) {
    return { ok: false, detail: 'That host is not allow-listed for this deployment.' };
  }
  const loopback = isLoopback(url.hostname);
  if (url.protocol === 'http:') {
    if (!(policy.allowInsecureLoopback && loopback)) {
      return { ok: false, detail: 'Only HTTPS destinations are allowed.' };
    }
  }

  let addresses: string[];
  if (isIP(url.hostname)) {
    addresses = [url.hostname];
  } else {
    try {
      const resolved = await lookup(url.hostname, { all: true, verbatim: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      return { ok: false, detail: 'That hostname could not be resolved.' };
    }
  }
  if (addresses.length === 0) return { ok: false, detail: 'That hostname has no address.' };
  if (!(policy.allowInsecureLoopback && loopback) && addresses.some((address) => !isPublicAddress(address))) {
    return { ok: false, detail: 'That destination resolves to a non-public address.' };
  }
  return { ok: true, target: { url, addresses } };
}

/**
 * A pinned HTTPS request. The `lookup` callback always returns the address that
 * was validated, so a DNS answer that changes between validation and connection
 * cannot redirect the request. Redirects are surfaced to the caller, never
 * followed; a caller that wants the new location must authorize it itself.
 */
export async function pinnedRequest(
  input: {
    target: ParsedTarget;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  },
  policy: DestinationPolicy,
): Promise<NetworkResponse> {
  const { url, addresses } = input.target;
  const maxBytes = policy.maxBytes ?? 65_536;
  const timeoutMs = policy.timeoutMs ?? 15_000;
  const pinned = addresses[0];

  // The loopback development concession is plaintext HTTP; every other
  // destination was required to be HTTPS by `authorizeUrl`.
  const dispatch = url.protocol === 'http:' ? httpRequest : httpsRequest;
  return await new Promise<NetworkResponse>((resolve, reject) => {
    const request = dispatch(
      url,
      {
        method: input.method,
        headers: input.headers ?? {},
        lookup: (_hostname, _options, callback) => {
          callback(null, pinned, isIP(pinned));
        },
        timeout: timeoutMs,
        rejectUnauthorized: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          if (bytes + chunk.length > maxBytes) {
            const remaining = Math.max(0, maxBytes - bytes);
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            bytes = maxBytes;
            truncated = true;
            return;
          }
          bytes += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
        });
        response.on('error', () => {
          reject(Object.assign(new Error('The response stream failed.'), { code: 'stream' }));
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('The request timed out.'), { code: 'timeout' }));
    });
    request.on('error', (error) => {
      reject(Object.assign(new Error('The request failed.'), { code: (error as NodeJS.ErrnoException).code ?? 'network' }));
    });
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

/** Refuses a URL that would carry a credential over cleartext. */
export function requireHttpsEndpoint(
  raw: string,
  label: string,
): { ok: true; url: URL } | { ok: false; detail: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, detail: `${label} is not a valid URL.` };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      detail: `${label} must use https so a credential or document is never sent in cleartext.`,
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, detail: `${label} may not carry credentials in the URL.` };
  }
  return { ok: true, url };
}
