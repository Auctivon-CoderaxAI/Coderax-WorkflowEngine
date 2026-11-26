import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creativeInstruction, extractCreativeBlock, validateCreativeArtifact } from '../../src/media/creative.js';

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>';

test('a fenced SVG becomes a validated artifact with a digest and safe path', () => {
  const result = validateCreativeArtifact({
    request: { format: 'svg', title: 'Launch Poster' },
    text: `Here is the artwork:\n\n\`\`\`svg\n${safeSvg}\n\`\`\``,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.artifact.mediaType, 'image/svg+xml');
  assert.equal(result.artifact.path, 'artifacts/launch-poster.svg');
  assert.equal(result.artifact.title, 'Launch Poster');
  assert.equal(result.artifact.sha256?.length, 64);
  assert.ok(result.artifact.content?.startsWith('<svg'));
  assert.equal(result.artifact.bytes, Buffer.byteLength(safeSvg, 'utf8'));
});

test('an SVG declaration is accepted, but scripting and external references are not', () => {
  const declared = `<?xml version="1.0"?>\n${safeSvg}`;
  assert.equal(validateCreativeArtifact({ request: { format: 'svg' }, text: declared }).ok, true);

  for (const hostile of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><style>@import "https://evil.test/x.css"</style></svg>',
    '<svg><image href="https://evil.test/x.png"/></svg>',
    '<svg><foreignObject><body>hi</body></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
  ]) {
    const result = validateCreativeArtifact({ request: { format: 'svg' }, text: hostile });
    assert.equal(result.ok, false, hostile);
  }
});

test('a local fragment reference is allowed in SVG', () => {
  const local = '<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>';
  const localHref = '<svg><use href="#shape"/></svg>';
  assert.equal(validateCreativeArtifact({ request: { format: 'svg' }, text: local }).ok, false);
  assert.equal(validateCreativeArtifact({ request: { format: 'svg' }, text: localHref }).ok, true);
});

test('HTML is accepted only as an inert fragment', () => {
  const safe = validateCreativeArtifact({
    request: { format: 'html', title: 'Card' },
    text: '```html\n<section><h1>Hello</h1><p>Static copy.</p></section>\n```',
  });
  assert.equal(safe.ok, true);

  for (const hostile of [
    '<section><script>alert(1)</script></section>',
    '<iframe src="https://evil.test"></iframe>',
    '<img src="x" onerror="alert(1)">',
    '<img src="https://evil.test/x.png">',
    '<video poster="https://evil.test/x.png"></video>',
    '<form action="https://evil.test"><input></form>',
    '<link rel="stylesheet" href="https://evil.test/x.css">',
    '<div style="background:url(https://evil.test/x)"></div>',
    '<a href="javascript:alert(1)">click</a>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
  ]) {
    const result = validateCreativeArtifact({ request: { format: 'html' }, text: hostile });
    assert.equal(result.ok, false, hostile);
  }
});

test('Markdown is refused when it embeds executable HTML', () => {
  const safe = validateCreativeArtifact({
    request: { format: 'markdown' },
    text: '# Notes\n\nA plain paragraph with *emphasis*.',
  });
  assert.equal(safe.ok, true);
  assert.equal(
    validateCreativeArtifact({
      request: { format: 'markdown' },
      text: '# Notes\n\n<script>alert(1)</script>',
    }).ok,
    false,
  );
  assert.equal(
    validateCreativeArtifact({
      request: { format: 'markdown' },
      text: '# Notes\n\n![tracker](https://evil.test/pixel.png)',
    }).ok,
    false,
  );
});

test('the format must match the returned document', () => {
  assert.equal(
    validateCreativeArtifact({ request: { format: 'svg' }, text: 'A plain answer.' }).ok,
    false,
  );
  assert.equal(
    validateCreativeArtifact({ request: { format: 'html' }, text: 'A plain answer.' }).ok,
    false,
  );
});

test('oversized creative output is refused', () => {
  const result = validateCreativeArtifact({
    request: { format: 'markdown' },
    text: 'a'.repeat(262_145),
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.detail : '', /limit/);
});

test('extraction prefers a fenced block and the instruction names the format', () => {
  assert.equal(
    extractCreativeBlock('before\n```svg\n<svg/>\n```\nafter', 'svg'),
    '<svg/>',
  );
  assert.equal(extractCreativeBlock('<svg></svg>', 'svg'), '<svg></svg>');
  assert.equal(extractCreativeBlock('prose', 'svg'), null);
  assert.match(creativeInstruction({ format: 'svg' }), /fenced ```svg/);
});
