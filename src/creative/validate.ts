import { createHash } from 'node:crypto';
import type {
  CreativeFinding,
  CreativeFindingCode,
  CreativeFormat,
  CreativeValidation,
} from '@coderax/contracts';

/**
 * A conservative allowlist scan for generated SVG and HTML.
 *
 * This is not a sanitizer and does not claim to be one. Anything the scanner does
 * not positively understand is refused: unknown elements, unquoted attributes,
 * external references, styles, entities and parser ambiguities all produce a
 * finding. A document with no findings is handed to the client with
 * `sandbox: 'required'`; a document with a finding never carries its body as an
 * artifact. Refusing is safer than rewriting markup that the engine cannot fully
 * model.
 */

const HTML_ELEMENTS = new Set([
  'html', 'head', 'body', 'title', 'meta', 'main', 'header', 'footer', 'section',
  'article', 'aside', 'nav', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'blockquote',
  'strong', 'em', 'b', 'i', 'code', 'pre', 'br', 'hr', 'table', 'caption',
  'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'mask', 'title', 'desc', 'use', 'symbol', 'pattern',
]);

const GLOBAL_ATTRIBUTES = new Set([
  'id', 'class', 'title', 'role', 'lang', 'dir', 'width', 'height',
]);

const HTML_ATTRIBUTES = new Set([
  'colspan', 'rowspan', 'scope', 'charset',
]);

const SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'viewbox', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-opacity', 'opacity', 'transform', 'font-size', 'font-family',
  'font-weight', 'text-anchor', 'dominant-baseline', 'preserveaspectratio',
  'gradientunits', 'offset', 'stop-color', 'stop-opacity', 'clippathunits',
  'patternunits', 'href', 'xlink:href',
]);

const VOID_ELEMENTS = new Set(['br', 'hr', 'meta']);

const ALLOWED_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-fA-F]{1,6});)/;

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:_-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9:_.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;

const ATTRIBUTE = /([a-zA-Z_:][a-zA-Z0-9:_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const MAX_ELEMENTS = 5_000;
const MAX_DEPTH = 32;

function controlCharacter(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

export function validateCreative(input: {
  format: CreativeFormat;
  content: string;
  maxBytes: number;
}): CreativeValidation {
  const findings: CreativeFinding[] = [];
  const push = (code: CreativeFindingCode, detail: string): void => {
    if (findings.length < 20) {
      findings.push({ code, detail: detail.slice(0, 300) });
    }
  };

  const bytes = Buffer.byteLength(input.content, 'utf8');
  const sha256 = createHash('sha256').update(input.content, 'utf8').digest('hex');
  const result = (): CreativeValidation => ({
    format: input.format,
    safe: findings.length === 0,
    findings,
    bytes: Math.min(bytes, Number.MAX_SAFE_INTEGER),
    sha256,
    sandbox: 'required',
  });

  if (bytes > input.maxBytes) {
    push('oversize', `The document is ${bytes} bytes, above the ${input.maxBytes}-byte limit.`);
    return result();
  }
  if (controlCharacter(input.content)) {
    push('control_character', 'The document contains control characters.');
  }

  const elements = input.format === 'svg' ? SVG_ELEMENTS : HTML_ELEMENTS;
  const attributes = input.format === 'svg' ? SVG_ATTRIBUTES : HTML_ATTRIBUTES;
  const stack: string[] = [];
  let roots = 0;
  let nodes = 0;
  let index = 0;

  while (index < input.content.length) {
    const next = input.content.indexOf('<', index);
    const text = input.content.slice(index, next === -1 ? input.content.length : next);
    if (ALLOWED_ENTITY.test(text)) {
      push('entity', 'The text contains an entity reference that is not in the allowlist.');
    }
    if (next === -1) break;

    if (input.content.startsWith('<!--', next)) {
      push('malformed', 'Comments are not part of the accepted subset.');
      break;
    }
    if (input.content.startsWith('<!', next) || input.content.startsWith('<?', next)) {
      push('entity', 'Doctype, entity and processing-instruction declarations are refused.');
      break;
    }

    TAG.lastIndex = next;
    const match = TAG.exec(input.content);
    if (!match) {
      push('malformed', 'A "<" does not begin a well-formed tag.');
      break;
    }
    index = TAG.lastIndex;

    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const selfClosing = match[4] === '/';
    nodes += 1;
    if (nodes > MAX_ELEMENTS) {
      push('oversize', 'The document has too many elements to validate.');
      break;
    }

    if (name === 'script') push('script', 'Script elements are refused.');
    if (name === 'iframe' || name === 'object' || name === 'embed' || name === 'frame') {
      push('embedded_object', `Embedded object elements such as <${name}> are refused.`);
    }
    if (name === 'style' || name === 'link' || name === 'base' || name === 'form') {
      push('style', `Styles, links, base URLs and forms such as <${name}> are refused.`);
    }
    if (name === 'foreignobject') {
      push('unsupported_element', 'foreignObject is refused because it can carry HTML content.');
    }
    if (!elements.has(name)) {
      push('unsupported_element', `<${name}> is not in the accepted element allowlist.`);
    }

    const rest = validateAttributes({
      raw: match[3] ?? '',
      name,
      format: input.format,
      attributes,
      push,
    });
    if (rest.trim().length > 0) {
      push('malformed', 'An attribute is not quoted correctly or was not parsed.');
    }

    if (closing) {
      if (selfClosing) {
        push('malformed', `The closing tag </${name}> must not be self-closing.`);
      }
      if ((match[3] ?? '').trim().length > 0) {
        push('malformed', `The closing tag </${name}> must not carry attributes.`);
      }
      const open = stack.pop();
      if (open !== name) {
        push('malformed', `The closing tag </${name}> does not match the open element.`);
        break;
      }
      continue;
    }

    if (
      input.format === 'html' &&
      selfClosing &&
      !VOID_ELEMENTS.has(name)
    ) {
      // HTML parsers ignore the slash on a non-void element, so `<div/>` would
      // silently become an open element. Refuse the ambiguity instead.
      push('malformed', `<${name}/> is not a void HTML element.`);
    }

    if (stack.length === 0) {
      roots += 1;
      if (input.format === 'svg' && roots > 1) {
        push('malformed', 'An SVG document must have exactly one root element.');
      }
      if (input.format === 'svg' && name !== 'svg') {
        push('unsupported_element', 'The SVG root element must be <svg>.');
      }
    }
    if (stack.length >= MAX_DEPTH) {
      push('oversize', `The document nests deeper than ${MAX_DEPTH} elements.`);
      break;
    }
    if (!VOID_ELEMENTS.has(name) && !selfClosing) stack.push(name);
  }

  if (stack.length > 0) {
    push('malformed', 'The document ends with an unclosed element.');
  }
  if (input.format === 'svg' && roots === 0) {
    push('malformed', 'The document has no SVG root element.');
  }

  return result();
}

function validateAttributes(input: {
  raw: string;
  name: string;
  format: CreativeFormat;
  attributes: ReadonlySet<string>;
  push: (code: CreativeFindingCode, detail: string) => void;
}): string {
  ATTRIBUTE.lastIndex = 0;
  let cursor = 0;
  let rest = '';
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(input.raw)) !== null) {
    rest += input.raw.slice(cursor, match.index);
    cursor = ATTRIBUTE.lastIndex;
    const attribute = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? '';

    if (attribute.startsWith('on')) {
      input.push('event_handler', `The event-handler attribute ${attribute} is refused.`);
      continue;
    }
    if (attribute === 'style') {
      input.push('style', 'Inline styles are refused.');
      continue;
    }
    if (attribute.startsWith('aria-') || attribute.startsWith('data-')) continue;

    const hrefLike =
      attribute === 'href' || attribute === 'xlink:href' || attribute === 'src';
    if (hrefLike) {
      if (
        input.format === 'svg' &&
        attribute !== 'src' &&
        value.trim().startsWith('#')
      ) {
        continue;
      }
      input.push(
        'external_reference',
        `The reference ${attribute} is not an internal fragment.`,
      );
      continue;
    }

    if (!GLOBAL_ATTRIBUTES.has(attribute) && !input.attributes.has(attribute)) {
      input.push('unsupported_attribute', `The attribute ${attribute} is not allowed.`);
      continue;
    }

    if (attribute === 'xmlns') {
      if (input.format !== 'svg' || input.name !== 'svg' || value !== 'http://www.w3.org/2000/svg') {
        input.push('external_reference', 'The xmlns value is not the SVG namespace.');
      }
    }
    if (attribute === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') {
      input.push('external_reference', 'The xlink namespace is not the standard one.');
    }
    if (attribute === 'charset' && (input.name !== 'meta' || value.toLowerCase() !== 'utf-8')) {
      input.push('unsupported_attribute', 'meta charset must be utf-8.');
    }
  }
  rest += input.raw.slice(cursor);
  return rest;
}
