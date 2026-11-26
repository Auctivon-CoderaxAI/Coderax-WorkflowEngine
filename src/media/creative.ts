import { createHash } from 'node:crypto';
import type { Artifact, CreativeFormat, CreativeRequest } from '@coderax/contracts';

/**
 * Creative output is text that a renderer will interpret, so the engine treats
 * it as untrusted input from the model. Validation is allow-by-construction and
 * fail-closed: a document containing a script, an event handler, an external
 * reference, a CSS fetch, a doctype or an entity is refused rather than
 * "cleaned". There is no heuristic rewrite of model output here.
 */

export type CreativeValidation =
  | { ok: true; artifact: Artifact }
  | { ok: false; detail: string };

const MAX_CONTENT_CHARS = 262_144;
const MAX_CONTENT_BYTES = 262_144;

const FORBIDDEN_SVG = [
  /<script\b/i,
  /<foreignObject\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<link\b/i,
  /<style\b/i,
  /<audio\b/i,
  /<video\b/i,
  /<canvas\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
  /\burl\s*\(/i,
  /@import/i,
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<!\s*\[CDATA\[/i,
  /<!--/,
  /\bsrc\s*=/i,
];

const FORBIDDEN_HTML = [
  /<script\b/i,
  /<style\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<link\b/i,
  /<meta\b/i,
  /<base\b/i,
  /<form\b/i,
  /<input\b/i,
  /<button\b/i,
  /<textarea\b/i,
  /<select\b/i,
  /<option\b/i,
  /<math\b/i,
  /<template\b/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:/i,
  /\bsrcdoc\s*=/i,
  /\bsrc\s*=/i,
  /\bposter\s*=/i,
  /\bbackground\s*=/i,
  /\bsrcset\s*=/i,
  /\bformaction\s*=/i,
  /\baction\s*=/i,
  /\burl\s*\(/i,
  /@import/i,
  /expression\s*\(/i,
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<!--/,
];

const FORBIDDEN_MARKDOWN = [
  /<script\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<style\b/i,
  /<img\b/i,
  /\bsrc\s*=/i,
  /!\[[^\]]*\]\(\s*https?:\/\//i,
  / javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /<!\s*\[CDATA\[/i,
];

function includesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function externalHref(text: string): boolean {
  const pattern = /\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi;
  for (const match of text.matchAll(pattern)) {
    const value = (match[2] ?? '').trim();
    if (value.length > 0 && !value.startsWith('#')) return true;
  }
  return false;
}

function slug(value: string | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * A fenced block is preferred; a raw document is accepted only when it begins
 * with the format's own opening token, so prose cannot be mistaken for SVG.
 */
export function extractCreativeBlock(text: string, format: CreativeFormat): string | null {
  const tags = format === 'svg' ? ['svg'] : format === 'html' ? ['html', 'htm'] : ['markdown', 'md'];
  for (const tag of tags) {
    const fenced = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i').exec(text);
    if (fenced?.[1]) return fenced[1].trim();
  }
  const anyFence = /```[a-z]*\s*\n([\s\S]*?)```/i.exec(text);
  if (anyFence?.[1]) return anyFence[1].trim();
  const raw = text.trim();
  if (format === 'svg') return /^<\?xml[\s\S]*?<svg\b/i.test(raw) || /^<svg\b/i.test(raw) ? raw : null;
  if (format === 'html') return /^</.test(raw) ? raw : null;
  return raw.length > 0 ? raw : null;
}

function validateSvg(content: string): string | null {
  const withoutDeclaration = content.replace(/^<\?xml[\s\S]*?\?>\s*/i, '');
  if (!/^<svg\b/i.test(withoutDeclaration)) return 'The artifact is not an SVG document.';
  if (!/<\/svg>\s*$/i.test(withoutDeclaration)) return 'The SVG document is not closed.';
  if (includesAny(withoutDeclaration, FORBIDDEN_SVG)) {
    return 'The SVG contains scripting, external references or a construct the engine refuses.';
  }
  if (externalHref(withoutDeclaration)) {
    return 'SVG references must be local fragments; external href values are refused.';
  }
  return null;
}

function validateHtml(content: string): string | null {
  if (!/^</.test(content)) return 'The artifact is not an HTML fragment.';
  if (includesAny(content, FORBIDDEN_HTML)) {
    return 'The HTML contains scripting, forms, external loads or a construct the engine refuses.';
  }
  if (externalHref(content)) {
    return 'HTML references must be local fragments; external href values are refused.';
  }
  return null;
}

function validateMarkdown(content: string): string | null {
  if (includesAny(content, FORBIDDEN_MARKDOWN)) {
    return 'The Markdown contains an executable construct the engine refuses.';
  }
  return null;
}

const MEDIA_TYPES: Readonly<Record<CreativeFormat, string>> = Object.freeze({
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
});

const EXTENSIONS: Readonly<Record<CreativeFormat, string>> = Object.freeze({
  markdown: 'md',
  html: 'html',
  svg: 'svg',
});

/**
 * Validates the model's deliverable and turns it into a durable artifact
 * descriptor. The artifact is returned in the task result; it is not written to
 * the workspace, so producing it cannot exceed the run's file permissions.
 */
export function validateCreativeArtifact(input: {
  request: CreativeRequest;
  text: string;
}): CreativeValidation {
  const content = extractCreativeBlock(input.text, input.request.format);
  if (content === null) {
    return {
      ok: false,
      detail: `The model did not return a ${input.request.format} artifact.`,
    };
  }
  if (content.length === 0) {
    return { ok: false, detail: 'The model returned an empty artifact.' };
  }
  if (content.length > MAX_CONTENT_CHARS) {
    return {
      ok: false,
      detail: `The artifact exceeds the ${MAX_CONTENT_CHARS} character limit.`,
    };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      detail: `The artifact exceeds the ${MAX_CONTENT_BYTES} byte limit.`,
    };
  }

  const problem =
    input.request.format === 'svg'
      ? validateSvg(content)
      : input.request.format === 'html'
        ? validateHtml(content)
        : validateMarkdown(content);
  if (problem) return { ok: false, detail: problem };

  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const name = slug(input.request.title) || `creative-${sha256.slice(0, 12)}`;
  return {
    ok: true,
    artifact: {
      path: `artifacts/${name}.${EXTENSIONS[input.request.format]}`,
      bytes: Buffer.byteLength(content, 'utf8'),
      digest: `sha256:${sha256}`,
      sha256,
      mediaType: MEDIA_TYPES[input.request.format],
      title: input.request.title ?? `Creative ${input.request.format}`,
      content,
    },
  };
}

/** The instruction the model receives; it is not part of the owner's objective. */
export function creativeInstruction(request: CreativeRequest): string {
  const language =
    request.format === 'svg'
      ? 'a single self-contained SVG document with no scripts, styles, external references or event handlers'
      : request.format === 'html'
        ? 'a single self-contained HTML fragment with no scripts, styles, forms or external references'
        : 'Markdown with no raw HTML or executable content';
  return [
    `Deliverable: ${language}.`,
    `Return exactly one fenced \`\`\`${request.format} block and nothing outside it.`,
    'The engine validates the document and refuses it if it contains an active or external construct.',
  ].join(' ');
}
