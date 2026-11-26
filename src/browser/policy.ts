import { createHash } from 'node:crypto';
import type {
  BrowserAction,
  BrowserElement,
  BrowserSensitiveCategory,
  BrowserTab,
  PermissionScope,
} from '@coderax/contracts';
import type { ProviderElement } from './types.js';

/**
 * Browser policy.
 *
 * Three rules are enforced here and nowhere else:
 *
 * 1. Navigation is confined to the session's exact origin allowlist.
 * 2. A committing action without a declared non-sensitive intent fails closed and
 *    needs a single-use owner approval. Page content never changes that.
 * 3. Everything a page produces is sanitized as untrusted data: control and
 *    bidirectional characters are removed and lengths are bounded. It is never
 *    parsed for instructions.
 */

const UNSAFE_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Keys that only move focus or scroll the page. Any other key can commit a form
// or trigger an application action, so it needs an approval.
const SAFE_PRESS_KEYS = new Set([
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

const SENSITIVE_CATEGORIES: readonly BrowserSensitiveCategory[] = [
  'file_transfer',
  'authentication',
  'account_change',
  'purchase',
  'irreversible',
];

const BLOCKED_TRANSFER_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-javascript',
  'application/xml',
  'text/xml',
]);

export type Sensitivity = {
  category: BrowserSensitiveCategory;
  scope: PermissionScope;
};

export function resourceFor(sessionId: string, category: BrowserSensitiveCategory): string {
  return `browser:${sessionId}:${category}`;
}

export function scopeFor(category: BrowserSensitiveCategory): PermissionScope {
  return category === 'file_transfer' ? 'browser.transfer' : 'browser.control';
}

export function sensitivityFor(
  action: BrowserAction,
  context: { passwordTarget: boolean; targetRole?: string },
): Sensitivity | null {
  // Intrinsic requirements come first. A declared purchase must never replace
  // the file-transfer approval for an upload/download or the authentication
  // approval for a password fill.
  if (action.type === 'upload' || action.type === 'download') {
    return sensitivity('file_transfer');
  }
  if (action.type === 'fill' && context.passwordTarget) {
    return sensitivity('authentication');
  }
  const declared = 'intent' in action ? action.intent?.category : undefined;
  if (declared && SENSITIVE_CATEGORIES.includes(declared as BrowserSensitiveCategory)) {
    return sensitivity(declared as BrowserSensitiveCategory);
  }
  // `form_input` is safe only for filling a field. A click, even one declared
  // as form input, can submit a form; only an observed link with an explicit
  // navigation intent avoids an approval.
  if (action.type === 'click') {
    const role = context.targetRole?.toLowerCase();
    if (declared === 'navigate' && role === 'link') return null;
    return sensitivity('irreversible');
  }
  if (action.type === 'press') {
    if (SAFE_PRESS_KEYS.has(action.key)) return null;
    return sensitivity('irreversible');
  }
  if (action.type === 'mouse') {
    if (action.input === 'move' || action.input === 'wheel') return null;
    return sensitivity('irreversible');
  }
  if (action.type === 'tab' && action.input === 'close') {
    return sensitivity('irreversible');
  }
  return null;
}

function sensitivity(category: BrowserSensitiveCategory): Sensitivity {
  return { category, scope: scopeFor(category) };
}

export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Accepts exact origins only. A path, query, fragment or credential in an
 * allowlist entry is refused rather than silently widened to its origin.
 */
export function normalizeOrigins(values: readonly string[]): string[] | null {
  const out = new Set<string>();
  for (const value of values) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
    out.add(url.origin);
  }
  return out.size > 0 ? [...out].sort() : null;
}

export function originAllowed(value: string, origins: readonly string[]): boolean {
  const origin = originOf(value);
  return origin !== null && origins.includes(origin);
}

export function sanitizePageUrl(
  value: string,
  options: { allowAboutBlank?: boolean } = {},
): string | null {
  const allowAboutBlank = options.allowAboutBlank ?? true;
  const trimmed = value.trim();
  if (allowAboutBlank && trimmed === 'about:blank') return 'about:blank';
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

export function sanitizeUntrusted(value: string, max: number): string {
  const cleaned = value.replace(UNSAFE_CHARACTERS, '').replace(/\r\n/g, '\n');
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function sanitizeLabel(value: string, max: number): string {
  return sanitizeUntrusted(value, max).replace(/\s+/g, ' ').trim();
}

export function cleanIdentifier(value: string, max: number): string | null {
  const cleaned = sanitizeUntrusted(value, max).trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeElements(elements: readonly ProviderElement[]): BrowserElement[] {
  const out: BrowserElement[] = [];
  const seen = new Set<string>();
  for (const element of elements.slice(0, 200)) {
    const elementId = cleanIdentifier(element.elementId, 200);
    if (!elementId || seen.has(elementId)) continue;
    seen.add(elementId);
    const role = sanitizeLabel(element.role, 64) || 'unknown';
    const value = element.value === undefined ? undefined : sanitizeUntrusted(element.value, 1000);
    const inputType = element.inputType === undefined ? undefined : sanitizeLabel(element.inputType, 64);
    out.push({
      elementId,
      role,
      name: sanitizeLabel(element.name, 300),
      ...(value !== undefined ? { value } : {}),
      ...(inputType ? { inputType } : {}),
      disabled: element.disabled === true,
      focused: element.focused === true,
    });
  }
  return out;
}

export function tabsWithinOrigins(
  tabs: readonly BrowserTab[],
  origins: readonly string[],
): boolean {
  return tabs.every((tab) => tab.url === 'about:blank' || originAllowed(tab.url, origins));
}

export function sanitizeTabs(tabs: readonly BrowserTab[]): BrowserTab[] | null {
  const out: BrowserTab[] = [];
  const seen = new Set<string>();
  for (const tab of tabs.slice(0, 20)) {
    const tabId = cleanIdentifier(tab.tabId, 200);
    const url = sanitizePageUrl(tab.url);
    if (!tabId || !url || seen.has(tabId)) return null;
    seen.add(tabId);
    out.push({
      tabId,
      url,
      title: sanitizeLabel(tab.title, 300),
      active: tab.active === true,
    });
  }
  return out;
}

export function decodeBase64(value: string, maxBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const data = Buffer.from(value, 'base64');
  if (data.length === 0 || data.length > maxBytes) return null;
  const canonical = data.toString('base64').replace(/=+$/, '');
  if (canonical !== value.replace(/=+$/, '')) return null;
  return data;
}

export function digestOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function detectImageType(data: Buffer): 'image/png' | 'image/jpeg' | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

export function matchesImageType(declared: string, data: Buffer): boolean {
  const detected = detectImageType(data);
  if (!detected) return false;
  const normalized = declared.toLowerCase().split(';')[0]?.trim();
  if (detected === 'image/jpeg') return normalized === 'image/jpeg' || normalized === 'image/jpg';
  return normalized === 'image/png';
}

export function isSafeTransferType(contentType: string): boolean {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,80}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,80}$/.test(normalized)) {
    return false;
  }
  return !BLOCKED_TRANSFER_TYPES.has(normalized);
}

export function sanitizeFilename(value: string): string | null {
  const cleaned = value
    .replace(/[\\/]/g, '')
    .replace(UNSAFE_CHARACTERS, '')
    .trim()
    .slice(0, 200);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}
