import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * A dependency regression test for GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404.
 *
 * The advisory covers every zod release below 4.6.6 and has no patched 3.x
 * line. A scanner reads the lockfile, so a source-level test cannot prove the
 * upgrade; this reads the resolved graph that is actually installed.
 */
test('the resolved zod version is at or above the patched advisory release', () => {
  const lock = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'package-lock.json'), 'utf8'),
  ) as {
    packages?: Record<string, { version?: string }>;
  };

  const versions = Object.entries(lock.packages ?? {})
    .filter(([name]) => name === 'node_modules/zod')
    .map(([, entry]) => entry.version)
    .filter((version): version is string => typeof version === 'string');

  assert.ok(versions.length > 0, 'the lockfile must contain a resolved zod package');
  for (const version of versions) {
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(
      major !== undefined &&
        minor !== undefined &&
        patch !== undefined &&
        (major > 4 ||
          (major === 4 && minor > 6) ||
          (major === 4 && minor === 6 && patch >= 6)),
      `zod ${version} is below the patched release 4.6.6`,
    );
  }
});

test('the installed zod package is the patched release', () => {
  const manifest = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'node_modules/zod/package.json'), 'utf8'),
  ) as { version?: string };
  const version = manifest.version ?? '';
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(
    major !== undefined &&
      minor !== undefined &&
      patch !== undefined &&
      (major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6)))),
    `installed zod ${version} is below 4.6.6`,
  );
});
