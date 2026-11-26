import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlobStore } from '../../src/persistence/blobs.js';
import { artifactHarness, base64, testDurableBlobs, textBytes } from '../fixtures/artifacts.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('slow concurrent readers renew their leases and survive a concurrent delete', async () => {
  const base = testDurableBlobs();
  const slow: BlobStore = {
    ...base,
    get: async (ref) => {
      await delay(180);
      return base.get(ref);
    },
  };
  const h = artifactHarness({ blobs: slow, readLeaseTtlMs: 45 });
  const body = textBytes('a slow but authorized read');
  const uploaded = await h.service.upload(h.owner, {
    filename: 'slow.txt',
    mediaType: 'text/plain',
    contentBase64: base64(body),
    mode: 'cloud',
  });
  assert.equal(uploaded.ok, true);
  if (!uploaded.ok) return;

  const first = h.service.download(h.owner, uploaded.value.artifact.artifactId, {
    mode: 'cloud',
  });
  const second = h.service.download(h.owner, uploaded.value.artifact.artifactId, {
    mode: 'cloud',
  });
  // The original 45 ms lease would have expired long before the read finishes.
  await delay(100);
  const removed = await h.service.remove(h.owner, uploaded.value.artifact.artifactId, 'cloud');
  assert.equal(removed.ok, true);

  for (const pending of [first, second]) {
    const result = await pending;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.contentBase64, base64(body));
  }

  const ref = {
    ownerId: h.owner.ownerId,
    mode: 'cloud' as const,
    sha256: uploaded.value.artifact.sha256,
  };
  assert.equal(await h.blobs.deleteIfUnreferenced(ref), true);
  assert.equal(await h.blobs.get(ref), null);
});

test('a download whose lease cannot be renewed fails closed', async () => {
  const base = testDurableBlobs();
  let leaseCalls = 0;
  const failing: BlobStore = {
    ...base,
    get: async (ref) => {
      await delay(180);
      return base.get(ref);
    },
    lease: async (input) => {
      leaseCalls += 1;
      // The first lease succeeds; every renewal loses the blob.
      return leaseCalls === 1 ? base.lease(input) : null;
    },
  };
  const h = artifactHarness({ blobs: failing, readLeaseTtlMs: 45 });
  const uploaded = await h.service.upload(h.owner, {
    filename: 'renewal.txt',
    mediaType: 'text/plain',
    contentBase64: base64(textBytes('renewal failure')),
    mode: 'cloud',
  });
  assert.equal(uploaded.ok, true);
  if (!uploaded.ok) return;

  const pending = h.service.download(h.owner, uploaded.value.artifact.artifactId, {
    mode: 'cloud',
  });
  await delay(100);
  await h.service.remove(h.owner, uploaded.value.artifact.artifactId, 'cloud');
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'storage_unavailable');
});
