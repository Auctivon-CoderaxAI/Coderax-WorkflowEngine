import { ROUTES } from './routes.js';

/**
 * Contract ownership.
 *
 * One operation has one runtime owner and one operation id. This registry is the
 * machine-readable half of that rule: it records the domain each published
 * operation belongs to, and it records the ids other branches proposed so a
 * duplicate or competing id is caught before it can be published here.
 *
 * It deliberately does not describe routes, schemas or handlers. Those remain in
 * `routes.ts`; a second description of the wire would be a competing contract.
 * The ownership test asserts this table and the route catalogue are the same set
 * in both directions, so an operation cannot be published without an owner and an
 * owner cannot be claimed for an operation the engine does not answer.
 *
 * `RESERVED_OPERATIONS` is not a wish list and never becomes OpenAPI. An entry
 * there is an operation declared by an unmerged branch, with the exact audited
 * head. It stays unpublished until that branch's runtime is merged and delegated
 * to, and the handshake reports the capability as unavailable in the meantime.
 * A `superseded` entry names the canonical id this contract publishes instead, so
 * two names never describe the same behaviour.
 */

/** A domain is the first tag of the route catalogue. */
export const DOMAIN_KEYS = [
  'health',
  'discovery',
  'chat',
  'work',
  'events',
  'conversations',
  'memory',
  'permissions',
  'notifications',
  'schedules',
  'artifacts',
  'games',
  'gaming-agent',
  'browser',
  'knowledge',
  'media',
  'creative',
  'teams',
  'contract',
] as const;
export type DomainKey = (typeof DOMAIN_KEYS)[number];

export type DomainOwner = {
  domain: DomainKey;
  /** The module that owns behaviour. Contracts never implement it here. */
  owner: string;
  /** Ref and exact head this ownership was audited at. */
  branch: string;
  head: string;
  state: 'integrated';
  note: string;
};

export type ReservedOperation = {
  id: string;
  domain: DomainKey | 'intelligence' | 'multiAgent' | 'scheduling' | 'scheduling.advanced';
  branch: string;
  head: string;
  status: 'blocked' | 'superseded';
  /** For `superseded`, the one published id that owns the behaviour. */
  canonical?: string;
  reason: string;
};

export const AUDIT_BASE = Object.freeze({
  branch: 'contract/authoritative-v1.1',
  head: 'ea660285b3c0a950067aa3b57f1764ccb509af8a',
});

/** Published operation id to domain. Derived, so it cannot drift from ROUTES. */
export const OPERATION_DOMAINS: Readonly<Record<string, DomainKey>> = Object.freeze(
  Object.fromEntries(
    ROUTES.map((route) => [route.operationId, (route.tags[0] ?? 'contract') as DomainKey]),
  ),
);

const DOMAIN_NOTES: Readonly<Record<DomainKey, { owner: string; note: string }>> = Object.freeze({
  health: { owner: 'src/observability/health.ts', note: 'Health, readiness and the capability handshake.' },
  discovery: { owner: 'src/agents/registry.ts, src/models/router.ts', note: 'Agents, tools and the verified zero-cost route; no paid path.' },
  chat: { owner: 'src/orchestration/service.ts', note: 'Negotiated JSON or typed SSE Chat; one agent per turn.' },
  work: { owner: 'src/orchestration/service.ts, src/execution/runner.ts', note: 'Durable Work execution, read model and control.' },
  events: { owner: 'src/events/bus.ts', note: 'Ordered execution events with cursor replay.' },
  conversations: { owner: 'src/persistence/conversations.ts', note: 'Owner-scoped conversation and transcript read models.' },
  memory: { owner: 'src/memory/store.ts', note: 'Exact private or cloud memory entries; the modes never overlap.' },
  permissions: { owner: 'src/permissions/store.ts', note: 'Durable approvals; a second decision on one request is refused.' },
  notifications: { owner: 'src/persistence/notifications.ts', note: 'Terminal-task notifications and owner-scoped acknowledgements.' },
  schedules: { owner: 'src/scheduling/engine.ts', note: 'One-shot and repeating schedules submitted by the engine tick.' },
  artifacts: { owner: 'src/artifacts/service.ts', note: 'Task-scoped artifact bytes with integrity verification and capacity accounting.' },
  games: { owner: 'src/games/studio.ts', note: 'Deterministic game generation and verification.' },
  'gaming-agent': { owner: 'src/games/session.ts', note: 'A game session’s observed state, logs and verification.' },
  browser: { owner: 'src/orchestration/browser.ts', note: 'Owner-scoped browser sessions and approval-bound actions.' },
  knowledge: { owner: 'src/knowledge/store.ts', note: 'Owner- and mode-scoped lexical retrieval over stored documents.' },
  media: { owner: 'src/media/service.ts', note: 'Validated inline images and owner-scoped durable media.' },
  creative: { owner: 'src/creative/service.ts', note: 'Validation of generated visual artifacts.' },
  teams: { owner: 'src/orchestration/team.ts', note: 'Bounded Native team execution and owner approval.' },
  contract: { owner: 'packages/contracts/src/routes.ts', note: 'The published route catalogue itself.' },
});

export const DOMAIN_OWNERS: readonly DomainOwner[] = Object.freeze(
  DOMAIN_KEYS.map((domain) => ({
    domain,
    ...DOMAIN_NOTES[domain],
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated' as const,
  })),
);

export const RESERVED_OPERATIONS: readonly ReservedOperation[] = Object.freeze([
{
    id: 'markNotificationRead',
    domain: 'notifications',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'markNotificationsRead',
    reason: 'Plural batch acknowledgement is the published shape; the singular id would be a second name for one behaviour.',
  },
{
    id: 'controlSchedule',
    domain: 'scheduling',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'cancelSchedule',
    reason: 'Cancellation is the only control the base implementation supports; a generic control id would advertise unimplemented pause and resume.',
  },
{
    id: 'deleteMemory',
    domain: 'memory',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'blocked',
    reason: 'Deletion is not implemented on this base; publishing it would be a simulated capability.',
  },
{
    id: 'searchMemory',
    domain: 'memory',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'blocked',
    reason: 'Only exact-key memory exists on this base; search is a different operation.',
  },
]);
