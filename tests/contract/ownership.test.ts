import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_BASE,
  DOMAIN_OWNERS,
  OPERATION_DOMAINS,
  RESERVED_OPERATIONS,
  ROUTES,
} from '@coderax/contracts';

/**
 * The ownership gate.
 *
 * The route catalogue says what the engine answers; this suite says who owns each
 * answer and refuses a second id for the same behaviour. It is deliberately
 * offline: a branch head recorded in `RESERVED_OPERATIONS` is evidence, not a
 * fetched dependency, so the check cannot be made green by a network outage or
 * quietly skip when GitHub is unavailable.
 */

const published = ROUTES.map((route) => route.operationId);

test('every published operation has exactly one owner and one id', () => {
  assert.equal(new Set(published).size, published.length, 'a duplicate operation id is a competing contract');
  assert.deepEqual(
    Object.keys(OPERATION_DOMAINS).sort(),
    [...published].sort(),
    'the ownership table and the route catalogue must be the same set',
  );
});

test('each domain has one recorded owner and no orphan domain', () => {
  const domains = [...new Set(Object.values(OPERATION_DOMAINS))].sort();
  const owners = DOMAIN_OWNERS.map((owner) => owner.domain);
  assert.equal(new Set(owners).size, owners.length, 'a domain must not be claimed twice');
  assert.deepEqual([...owners].sort(), domains, 'a domain without an owner, or an owner without an operation');

  for (const owner of DOMAIN_OWNERS) {
    assert.match(owner.head, /^[0-9a-f]{40}$/, `${owner.domain} records an exact audited head`);
    assert.ok(owner.owner.trim().length > 0, `${owner.domain} names the runtime module`);
    assert.ok(owner.note.trim().length > 0, `${owner.domain} explains its boundary`);
  }
  assert.match(AUDIT_BASE.head, /^[0-9a-f]{40}$/);
});

test('a reserved id is never published and a superseded id names its canonical operation', () => {
  const ids = new Set(published);
  const reservedIds = RESERVED_OPERATIONS.map((operation) => operation.operationId);
  assert.equal(new Set(reservedIds).size, reservedIds.length, 'a reserved operation cannot be listed twice');

  for (const reserved of RESERVED_OPERATIONS) {
    assert.equal(
      ids.has(reserved.operationId),
      false,
      `${reserved.operationId} is reserved by ${reserved.branch} and must not be published on this base`,
    );
    assert.match(reserved.head, /^[0-9a-f]{40}$/, `${reserved.operationId} records an exact branch head`);
    assert.ok(reserved.reason.trim().length > 0, `${reserved.operationId} states why it is withheld`);

    if (reserved.status === 'superseded') {
      assert.ok(reserved.canonical, `${reserved.operationId} must name the id that owns the behaviour`);
      assert.ok(ids.has(reserved.canonical), `${reserved.canonical} must be a published operation`);
      assert.notEqual(reserved.canonical, reserved.operationId);
    } else {
      assert.equal(
        reserved.canonical,
        undefined,
        `${reserved.operationId} is blocked, so it cannot redirect to an implemented operation`,
      );
    }
  }
});

test('the ownership table does not invent an operation the catalogue does not answer', () => {
  const catalogue = new Map(ROUTES.map((route) => [route.operationId, route]));
  for (const [operationId, domain] of Object.entries(OPERATION_DOMAINS)) {
    const route = catalogue.get(operationId);
    assert.ok(route, `${operationId} is claimed by ${domain} but not declared in ROUTES`);
    assert.ok(route.summary.trim().length > 0);
  }
});
