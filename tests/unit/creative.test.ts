import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCreativeService } from '../../src/creative/service.js';

const creative = createCreativeService({ maxBytes: 262_144 });

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="#336699"/></svg>';
const SAFE_HTML =
  '<div class="card"><h1>Title</h1><p>Text &amp; more</p><ul><li>One</li></ul></div>';

test('the accepted subset validates and is still marked for sandboxed rendering', () => {
  const svg = creative.validate({ format: 'svg', content: SAFE_SVG });
  assert.equal(svg.safe, true);
  assert.deepEqual(svg.findings, []);
  assert.equal(svg.sandbox, 'required');

  const html = creative.validate({ format: 'html', content: SAFE_HTML });
  assert.equal(html.safe, true);
  assert.deepEqual(html.findings, []);
});

test('scripts, handlers and embedded objects are refused', () => {
  const cases: Array<[string, string, string]> = [
    ['html', '<div><script>alert(1)</script></div>', 'script'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', 'event_handler'],
    ['html', '<div onclick="alert(1)">x</div>', 'event_handler'],
    ['html', '<iframe src="https://example.test"></iframe>', 'embedded_object'],
    ['html', '<object data="x"></object>', 'embedded_object'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>x</div></foreignObject></svg>', 'unsupported_element'],
  ];
  for (const [format, content, code] of cases) {
    const result = creative.validate({ format: format as 'svg' | 'html', content });
    assert.equal(result.safe, false, content);
    assert.ok(
      result.findings.some((finding) => finding.code === code),
      `expected ${code} in ${JSON.stringify(result.findings)}`,
    );
  }
});

test('external references, styles and entities are refused', () => {
  const cases: Array<[string, string, string]> = [
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/x.png"/></svg>', 'unsupported_element'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.test/x#a"/></svg>', 'external_reference'],
    ['html', '<div style="background:url(https://example.test)">x</div>', 'style'],
    ['html', '<style>body{color:red}</style>', 'style'],
    ['html', '<p>Tom &amp; Jerry &unknown;</p>', 'entity'],
    ['svg', '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>', 'entity'],
  ];
  for (const [format, content, code] of cases) {
    const result = creative.validate({ format: format as 'svg' | 'html', content });
    assert.equal(result.safe, false, content);
    assert.ok(
      result.findings.some((finding) => finding.code === code),
      `expected ${code} in ${JSON.stringify(result.findings)}`,
    );
  }
});

test('unknown elements, unquoted attributes and unbalanced markup are refused', () => {
  const unknown = creative.validate({ format: 'html', content: '<marquee>hi</marquee>' });
  assert.equal(unknown.safe, false);
  assert.ok(unknown.findings.some((finding) => finding.code === 'unsupported_element'));

  const unquoted = creative.validate({ format: 'html', content: '<div id=main>hi</div>' });
  assert.equal(unquoted.safe, false);
  assert.ok(unquoted.findings.some((finding) => finding.code === 'malformed'));

  const unbalanced = creative.validate({ format: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>' });
  assert.equal(unbalanced.safe, false);
  assert.ok(unbalanced.findings.some((finding) => finding.code === 'malformed'));

  const comment = creative.validate({ format: 'html', content: '<div><!-- hidden --></div>' });
  assert.equal(comment.safe, false);
});

test('oversized and control-character documents are refused', () => {
  const oversized = creative.validate({
    format: 'html',
    content: `<div>${'x'.repeat(300_000)}</div>`,
  });
  assert.equal(oversized.safe, false);
  assert.ok(oversized.findings.some((finding) => finding.code === 'oversize'));

  const control = creative.validate({ format: 'html', content: '<div>\u0000</div>' });
  assert.equal(control.safe, false);
  assert.ok(control.findings.some((finding) => finding.code === 'control_character'));
});

test('extraction keeps safe content and withholds an unsafe body', () => {
  const text = [
    'Here is a drawing:',
    '```svg',
    SAFE_SVG,
    '```',
    'And a page:',
    '```html',
    '<script>steal()</script>',
    '```',
  ].join('\n');
  const artifacts = creative.extract(text);
  assert.equal(artifacts.length, 2);

  const safe = artifacts.find((artifact) => artifact.format === 'svg');
  assert.equal(safe?.safe, true);
  assert.equal(safe?.content, SAFE_SVG);

  const unsafe = artifacts.find((artifact) => artifact.format === 'html');
  assert.equal(unsafe?.safe, false);
  assert.equal(unsafe?.content, undefined);
  assert.ok(unsafe?.findings.some((finding) => finding.code === 'script'));

  assert.equal(creative.extract('no fenced creative output here').length, 0);
});
