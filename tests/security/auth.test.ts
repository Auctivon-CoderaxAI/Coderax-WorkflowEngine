import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

test('health is public, owner operations are not', async () => {
  const started = await startTestApp();
  try {
    const health = await fetch(`${started.url}/v1/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { contractVersion: string };
    assert.equal(body.contractVersion, '1.0.0');

    const anonymous = await fetch(`${started.url}/v1/agents`);
    assert.equal(anonymous.status, 401);
    const problem = (await anonymous.json()) as { code: string; retryable: boolean };
    assert.equal(problem.code, 'unauthorized');
    assert.equal(problem.retryable, false);
  } finally {
    await started.close();
  }
});

test('a wrong token is rejected and a correct one is accepted', async () => {
  const started = await startTestApp();
  try {
    const wrong = await fetch(`${started.url}/v1/agents`, {
      headers: { authorization: 'Bearer not-the-owner-token-but-long-enough' },
    });
    assert.equal(wrong.status, 401);

    const malformed = await fetch(`${started.url}/v1/agents`, {
      headers: { authorization: OWNER_TOKEN },
    });
    assert.equal(malformed.status, 401);

    const accepted = await fetch(`${started.url}/v1/agents`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { agents: Array<{ id: string }> };
    assert.deepEqual(
      body.agents.map((agent) => agent.id),
      ['coderax', 'opencode', 'freebuff'],
    );
  } finally {
    await started.close();
  }
});

test('an unknown route is a typed not-found, not an HTML fallback', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/nope`, {
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'not_found');
    assert.equal(response.headers.get('content-type')?.startsWith('application/json'), true);
  } finally {
    await started.close();
  }
});

test('an oversized request body is refused before parsing', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/work`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ objective: 'x'.repeat(1_048_577) }),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'validation_failed');
  } finally {
    await started.close();
  }
});

test('a request body is validated against the published contract', async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/work`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ objective: '' }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; detail: string };
    assert.equal(body.code, 'validation_failed');
    assert.ok(body.detail.includes('objective'));
  } finally {
    await started.close();
  }
});
