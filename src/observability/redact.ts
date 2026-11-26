/**
 * Secret scrubbing for anything that can leave the engine.
 *
 * An adapter's failure text and a provider's error body are the two places a
 * credential or a home path most often escapes, because both are written by
 * someone else. Redaction is applied at the boundary rather than trusted to each
 * caller: a redacted string is safe to persist, stream and show in a UI.
 */

/** Long, credential-shaped values that must never be echoed back. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // A scheme may carry several comma-separated parameters (e.g. Digest).
  // Treat an unquoted non-Bearer authorization field as opaque through end of line.
  [/(authorization\b["']?\s*[:=][ \t]*)(?!Bearer\b)[a-z][\w.+-]*[ \t]+[^\r\n]*/gi, '$1[redacted]'],
  [/(authorization\b["']?\s*[:=][ \t]*Bearer)[ \t]+[^\s,;]+/gi, '$1 [redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, '$1 [redacted]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[redacted-key]'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, '[redacted-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/([?&](?:token|key|api_key|apikey|password|secret|sig)=)[^&\s]+/gi, '$1[redacted]'],
  [
    // `Bearer` is handled above, so it is not re-consumed as a bare value.
    /((?:token|password|passwd|secret|api[_-]?key|authorization)\b["']?\s*[:=]\s*)(?!Bearer\b)("(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|'(?:\\[\s\S]|[^'\\])*(?:'|\\?$)|[^\s,;]+)/gi,
    '$1[redacted]',
  ],
  // Absolute home directories leak an owner's name and layout.
  [/(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\\/\s"']+/g, '[home]'],
];

/** Preserve the length of ordinary assistant replies; diagnostics are bounded separately. */
export function redactContent(value: string): string {
  for (const [pattern, replacement] of PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

export function redactToolInput(input: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(input, (key, value: unknown) => {
      if (/(?:token|password|passwd|secret|api[_-]?key|authorization)$/i.test(key)) return '[redacted]';
      return typeof value === 'string' ? redactContent(value) : value;
    }));
  } catch {
    return '[redacted]';
  }
}

/** Bounds the work a pathological string can cause. */
const MAX_INPUT = 20_000;
const MAX_OUTPUT = 4_000;

/**
 * Scrubs a string for persistence or display. Explicit `secrets` are replaced
 * first, so a configured value is removed even when it does not match a pattern.
 */
export function redactText(
  value: string,
  secrets: readonly string[] = [],
  limit: number = MAX_OUTPUT,
): string {
  let text = value.slice(0, MAX_INPUT);
  for (const secret of secrets) {
    if (secret.length >= 8) {
      text = text.split(secret).join('[redacted]');
    }
  }
  text = redactContent(text);
  const bound = Math.min(Math.max(1, limit), MAX_OUTPUT);
  return text.length > bound ? `${text.slice(0, bound - 1)}…` : text;
}

