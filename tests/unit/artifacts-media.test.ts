import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTIFACT_MEDIA_TYPES, type ArtifactKind, type ArtifactMediaType } from '@coderax/contracts';
import {
  decodeContent,
  detectFamily,
  digestOf,
  validateContent,
  validateFilename,
} from '../../src/artifacts/media.js';
import {
  codeBytes,
  jpegBytes,
  odfBytes,
  ooxmlBytes,
  pdfBytes,
  pngBytes,
  textBytes,
  zipBytes,
} from '../fixtures/artifacts.js';

function reject(input: {
  filename: string;
  mediaType: ArtifactMediaType;
  content: Buffer;
  code?: string;
  requestedKind?: ArtifactKind;
  declaredSha256?: string;
}): void {
  const result = validateContent({
    filename: input.filename,
    mediaType: input.mediaType,
    content: input.content,
    ...(input.requestedKind ? { requestedKind: input.requestedKind } : {}),
    ...(input.declaredSha256 ? { declaredSha256: input.declaredSha256 } : {}),
  });
  assert.equal(result.ok, false, `${input.filename} should have been rejected`);
  if (!result.ok && input.code) {
    assert.equal(result.code, input.code);
  }
}

test('file names can never be interpreted as a path, a hidden file or a spoof', () => {
  const rejected = [
    '../../etc/passwd.pdf',
    '..\\..\\windows\\system.ini.pdf',
    '/absolute/report.pdf',
    '.env',
    '.hidden.pdf',
    'report.',
    'report ',
    'CON.pdf',
    'lpt1.pdf',
    'invoice\u202efdp.pdf',
    'a\u0000b.pdf',
    'no-extension',
    '',
  ];
  for (const filename of rejected) {
    const result = validateFilename(filename);
    assert.equal(result.ok, false, `${JSON.stringify(filename)} should be rejected`);
  }

  const accepted = validateFilename('quarterly report.pdf');
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.value.filename, 'quarterly report.pdf');
    assert.equal(accepted.value.extension, 'pdf');
  }
});

test('only canonical base64 is accepted', () => {
  assert.equal(decodeContent('aGVsbG8=').ok, true);
  for (const value of [' aGVsbG8=', 'aGVsbG8', 'aGVs bG8=', '!!!!', 'aGVsbG8===']) {
    assert.equal(decodeContent(value).ok, false, `${value} should not decode`);
  }
  const digest = digestOf(textBytes('stable content'));
  assert.equal(digest, digestOf(textBytes('stable content')));
  assert.notEqual(digest, digestOf(textBytes('stable content.')));
});

test('signatures are detected from bytes, not from the declared type', () => {
  assert.equal(detectFamily(pngBytes()), 'png');
  assert.equal(detectFamily(jpegBytes()), 'jpeg');
  assert.equal(detectFamily(pdfBytes()), 'pdf');
  assert.equal(detectFamily(zipBytes()), 'office');
  assert.equal(detectFamily(textBytes('{"a":1}')), 'json');
  assert.equal(detectFamily(textBytes('plain text')), 'text');
  assert.equal(detectFamily(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), 'unknown');
});

test('a declared media type that disagrees with the signature is refused', () => {
  reject({ filename: 'chart.png', mediaType: 'image/png', content: pdfBytes() });
  reject({ filename: 'photo.jpg', mediaType: 'image/jpeg', content: pngBytes() });
  reject({ filename: 'document.txt', mediaType: 'text/plain', content: pngBytes() });
  // An executable renamed as text is not text.
  reject({
    filename: 'tool.txt',
    mediaType: 'text/plain',
    content: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
  });
});

test('extensions must agree with the declared media type', () => {
  reject({
    filename: 'photo.jpg',
    mediaType: 'image/png',
    content: pngBytes(),
    code: 'validation_failed',
  });
  reject({
    filename: 'report.pdf',
    mediaType: 'image/png',
    content: pngBytes(),
    code: 'validation_failed',
  });
  reject({
    filename: 'code.tsx',
    mediaType: 'application/pdf',
    content: pdfBytes(),
    code: 'unsupported_media_type',
  });
  // HTML and SVG are not on the allowlist even when the content is text.
  reject({
    filename: 'page.html',
    mediaType: 'text/plain',
    content: textBytes('<html></html>'),
    code: 'unsupported_media_type',
  });
  reject({
    filename: 'icon.svg',
    mediaType: 'text/plain',
    content: textBytes('<svg/>'),
    code: 'unsupported_media_type',
  });
});

test('archives are refused and office containers are never expanded', () => {
  reject({
    filename: 'bundle.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: zipBytes(),
    code: 'unsupported_media_type',
  });
  reject({
    filename: 'report.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: ooxmlBytes('xlsx'),
    code: 'unsupported_media_type',
  });
  // A zip bomb signature is opaque and rejected; nothing inflates it.
  const bomb = Buffer.concat([zipBytes(), Buffer.alloc(4096)]);
  reject({
    filename: 'bomb.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: bomb,
    code: 'unsupported_media_type',
  });

  const xlsx = validateContent({
    filename: 'sheet.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: ooxmlBytes('xlsx'),
  });
  assert.equal(xlsx.ok, true);

  const odt = validateContent({
    filename: 'notes.odt',
    mediaType: 'application/vnd.oasis.opendocument.text',
    content: odfBytes('text'),
  });
  assert.equal(odt.ok, true);
});

test('text must be UTF-8 without NUL bytes and JSON must parse', () => {
  assert.equal(
    validateContent({
      filename: 'payload.json',
      mediaType: 'application/json',
      content: textBytes('{"ok":true}'),
    }).ok,
    true,
  );
  reject({
    filename: 'payload.json',
    mediaType: 'application/json',
    content: textBytes('{not json}'),
  });
  reject({
    filename: 'notes.txt',
    mediaType: 'text/plain',
    content: Buffer.concat([textBytes('hello'), Buffer.from([0x00])]),
  });
  reject({
    filename: 'notes.txt',
    mediaType: 'text/plain',
    content: Buffer.from([0xc3, 0x28]),
  });
});

test('a declared digest that does not match the bytes is refused', () => {
  const content = textBytes('exact bytes');
  const good = digestOf(content);
  assert.equal(
    validateContent({
      filename: 'notes.txt',
      mediaType: 'text/plain',
      content,
      declaredSha256: good,
    }).ok,
    true,
  );
  reject({
    filename: 'notes.txt',
    mediaType: 'text/plain',
    content,
    declaredSha256: 'b'.repeat(64),
    code: 'validation_failed',
  });
});

test('every advertised media type is accepted with a matching signature', () => {
  const mp4 = (brand: string, extension: string): { filename: string; content: Buffer } => ({
    filename: `media.${extension}`,
    content: Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftyp', 'latin1'),
      Buffer.from(brand, 'latin1'),
      Buffer.from([0x00, 0x00, 0x02, 0x00]),
    ]),
  });
  const cases: Array<{ mediaType: ArtifactMediaType; filename: string; content: Buffer }> = [
    { mediaType: 'text/plain', filename: 'notes.txt', content: textBytes('plain') },
    { mediaType: 'text/markdown', filename: 'notes.md', content: textBytes('# heading') },
    { mediaType: 'text/csv', filename: 'rows.csv', content: textBytes('a,b\n1,2') },
    { mediaType: 'text/tab-separated-values', filename: 'rows.tsv', content: textBytes('a\tb') },
    { mediaType: 'application/json', filename: 'data.json', content: textBytes('{"a":1}') },
    { mediaType: 'application/pdf', filename: 'report.pdf', content: pdfBytes() },
    {
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'report.docx',
      content: ooxmlBytes('docx'),
    },
    {
      mediaType: 'application/vnd.oasis.opendocument.text',
      filename: 'report.odt',
      content: odfBytes('text'),
    },
    {
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'book.xlsx',
      content: ooxmlBytes('xlsx'),
    },
    {
      mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
      filename: 'book.ods',
      content: odfBytes('spreadsheet'),
    },
    {
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: 'deck.pptx',
      content: ooxmlBytes('pptx'),
    },
    {
      mediaType: 'application/vnd.oasis.opendocument.presentation',
      filename: 'deck.odp',
      content: odfBytes('presentation'),
    },
    { mediaType: 'image/png', filename: 'image.png', content: pngBytes() },
    { mediaType: 'image/jpeg', filename: 'image.jpg', content: jpegBytes() },
    {
      mediaType: 'image/gif',
      filename: 'image.gif',
      content: Buffer.from('GIF89a-payload', 'latin1'),
    },
    {
      mediaType: 'image/webp',
      filename: 'image.webp',
      content: Buffer.concat([
        Buffer.from('RIFF', 'latin1'),
        Buffer.from([0x10, 0x00, 0x00, 0x00]),
        Buffer.from('WEBPVP8 ', 'latin1'),
      ]),
    },
    {
      mediaType: 'audio/mpeg',
      filename: 'clip.mp3',
      content: Buffer.from('ID3\x04\x00-payload', 'latin1'),
    },
    {
      mediaType: 'audio/wav',
      filename: 'clip.wav',
      content: Buffer.concat([
        Buffer.from('RIFF', 'latin1'),
        Buffer.from([0x10, 0x00, 0x00, 0x00]),
        Buffer.from('WAVEfmt ', 'latin1'),
      ]),
    },
    {
      mediaType: 'audio/ogg',
      filename: 'clip.ogg',
      content: Buffer.from('OggS-payload', 'latin1'),
    },
    {
      mediaType: 'audio/flac',
      filename: 'clip.flac',
      content: Buffer.from('fLaC-payload', 'latin1'),
    },
    { mediaType: 'audio/mp4', ...mp4('M4A ', 'm4a') },
    { mediaType: 'video/mp4', ...mp4('isom', 'mp4') },
    {
      mediaType: 'video/webm',
      filename: 'clip.webm',
      content: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]),
    },
    {
      mediaType: 'video/ogg',
      filename: 'clip.ogv',
      content: Buffer.from('OggS-video', 'latin1'),
    },
    { mediaType: 'video/quicktime', ...mp4('qt  ', 'mov') },
  ];

  assert.equal(cases.length, ARTIFACT_MEDIA_TYPES.length);
  assert.deepEqual(
    cases.map((entry) => entry.mediaType).sort(),
    [...ARTIFACT_MEDIA_TYPES].sort(),
  );
  for (const entry of cases) {
    const result = validateContent(entry);
    assert.equal(result.ok, true, `${entry.mediaType} should be accepted`);
    if (result.ok) {
      assert.ok(result.value.kind.length > 0);
      assert.equal(result.value.sha256, digestOf(entry.content));
    }
  }
});

test('source code and spreadsheets resolve to distinct kinds', () => {
  const source = validateContent({
    filename: 'answer.ts',
    mediaType: 'text/plain',
    content: codeBytes(),
  });
  assert.equal(source.ok, true);
  if (source.ok) assert.equal(source.value.kind, 'source');

  const document = validateContent({
    filename: 'notes.md',
    mediaType: 'text/markdown',
    content: textBytes('# Notes'),
  });
  assert.equal(document.ok, true);
  if (document.ok) assert.equal(document.value.kind, 'document');

  const data = validateContent({
    filename: 'series.json',
    mediaType: 'application/json',
    content: textBytes('[1,2,3]'),
  });
  assert.equal(data.ok, true);
  if (data.ok) assert.equal(data.value.kind, 'data');

  const visualization = validateContent({
    filename: 'series.json',
    mediaType: 'application/json',
    content: textBytes('[1,2,3]'),
    requestedKind: 'visualization',
  });
  assert.equal(visualization.ok, true);
  if (visualization.ok) assert.equal(visualization.value.kind, 'visualization');

  reject({
    filename: 'sheet.csv',
    mediaType: 'text/csv',
    content: textBytes('a,b\n1,2'),
    requestedKind: 'project',
    code: 'validation_failed',
  });
});
