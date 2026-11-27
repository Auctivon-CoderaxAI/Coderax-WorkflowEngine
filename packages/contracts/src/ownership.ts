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

export type DomainKey =
  | 'platform'
  | 'discovery'
  | 'chat'
  | 'work'
  | 'events'
  | 'conversations'
  | 'memory'
  | 'permissions'
  | 'notifications'
  | 'scheduling'
  | 'artifacts';

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
  operationId: string;
  domain: DomainKey | 'intelligence' | 'multiAgent' | 'scheduling.advanced';
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

/** Published operation id to domain. Exactly the route catalogue, one entry each. */
export const OPERATION_DOMAINS: Readonly<Record<string, DomainKey>> = Object.freeze({
  getHealth: 'platform',
  getReadiness: 'platform',
  getHandshake: 'platform',
  listAgents: 'discovery',
  listModels: 'discovery',
  submitChat: 'chat',
  submitWork: 'work',
  getTask: 'work',
  listTasks: 'work',
  cancelTask: 'work',
  resumeTask: 'work',
  retryTask: 'work',
  streamTaskEvents: 'events',
  listConversations: 'conversations',
  getConversation: 'conversations',
  listMemory: 'memory',
  putMemory: 'memory',
  listPermissions: 'permissions',
  listPendingPermissions: 'permissions',
  decidePermission: 'permissions',
  listNotifications: 'notifications',
  markNotificationsRead: 'notifications',
  listSchedules: 'scheduling',
  createSchedule: 'scheduling',
  getSchedule: 'scheduling',
  cancelSchedule: 'scheduling',
  listTaskArtifacts: 'artifacts',
  uploadTaskArtifact: 'artifacts',
  getArtifact: 'artifacts',
  getArtifactContent: 'artifacts',
});

export const DOMAIN_OWNERS: readonly DomainOwner[] = Object.freeze([
  {
    domain: 'platform',
    owner: 'src/observability/health.ts, src/orchestration/service.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Health, readiness and the handshake generated from the route catalogue.',
  },
  {
    domain: 'discovery',
    owner: 'src/agents/registry.ts, src/models/catalog.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Agents and the verified zero-cost model catalogue; no paid route.',
  },
  {
    domain: 'chat',
    owner: 'src/orchestration/service.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Negotiated JSON or typed SSE Chat; one agent per turn.',
  },
  {
    domain: 'work',
    owner: 'src/orchestration/service.ts, src/execution/runner.ts, src/persistence/tasks.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Durable Work execution, read model, idempotent submission and control.',
  },
  {
    domain: 'events',
    owner: 'src/events/bus.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Ordered execution events with cursor replay in the running process. Durable cross-process storage is still owned by feat/durable-events-integration and is reported as unconfigured, not published as durable.',
  },
  {
    domain: 'conversations',
    owner: 'src/persistence/conversations.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Owner-scoped conversation and transcript read models.',
  },
  {
    domain: 'memory',
    owner: 'src/memory/store.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Exact private or cloud memory entries; the modes never overlap.',
  },
  {
    domain: 'permissions',
    owner: 'src/permissions/store.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Durable approvals; a second decision on one request is refused.',
  },
  {
    domain: 'notifications',
    owner: 'src/persistence/notifications.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Terminal-task notifications and owner-scoped acknowledgements.',
  },
  {
    domain: 'scheduling',
    owner: 'src/persistence/schedules.ts, src/scheduling/scheduler.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'One-shot and repeating schedules submitted by the engine tick. Editing, pausing and occurrence history remain reserved to feat/durable-scheduling.',
  },
  {
    domain: 'artifacts',
    owner: 'src/artifacts/store.ts',
    branch: AUDIT_BASE.branch,
    head: AUDIT_BASE.head,
    state: 'integrated',
    note: 'Task-scoped artifact bytes with sha256 verification and traversal-safe paths. Capacity reservations and reference counting remain reserved to the durable artifacts branch.',
  },
]);

export const RESERVED_OPERATIONS: readonly ReservedOperation[] = Object.freeze([
  {
    operationId: 'listTools',
    domain: 'intelligence',
    branch: 'PR #2 (origin/pr/2)',
    head: 'e14e4b714a5091b51cd2d0598b2b17cca56435f3',
    status: 'blocked',
    reason: 'Route declared on the intelligence branch; no handler on this contract base.',
  },
  {
    operationId: 'getRouting',
    domain: 'intelligence',
    branch: 'PR #2 (origin/pr/2)',
    head: 'e14e4b714a5091b51cd2d0598b2b17cca56435f3',
    status: 'blocked',
    reason: 'Provider eligibility report lives on feat/intelligence-core; PR #4 owns routing.',
  },
  {
    operationId: 'ingestKnowledge',
    domain: 'intelligence',
    branch: 'PR #2 (origin/pr/2)',
    head: 'e14e4b714a5091b51cd2d0598b2b17cca56435f3',
    status: 'blocked',
    reason: 'No embedding provider or vector index exists on this base.',
  },
  {
    operationId: 'listKnowledge',
    domain: 'intelligence',
    branch: 'PR #2 (origin/pr/2)',
    head: 'e14e4b714a5091b51cd2d0598b2b17cca56435f3',
    status: 'blocked',
    reason: 'Read model for the unmerged knowledge store.',
  },
  {
    operationId: 'searchKnowledge',
    domain: 'intelligence',
    branch: 'PR #2 (origin/pr/2)',
    head: 'e14e4b714a5091b51cd2d0598b2b17cca56435f3',
    status: 'blocked',
    reason: 'Requires the retrieval implementation that is not on this base.',
  },
  {
    operationId: 'submitTeam',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'PR #8 adds bounded Native team orchestration; not merged here.',
  },
  {
    operationId: 'getTeam',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'Team read model belongs to PR #8.',
  },
  {
    operationId: 'resumeTeam',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'Team control belongs to PR #8.',
  },
  {
    operationId: 'cancelTeam',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'Team control belongs to PR #8.',
  },
  {
    operationId: 'listTeamPermissions',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'Team-scoped approvals belong to PR #8 and its supervisor owner.',
  },
  {
    operationId: 'decideTeamPermission',
    domain: 'multiAgent',
    branch: 'PR #8 (origin/pr/8)',
    head: 'ffec08f43bd837c7600d83138d538982e8607048',
    status: 'blocked',
    reason: 'Team-scoped approvals belong to PR #8 and its supervisor owner.',
  },
  {
    operationId: 'updateSchedule',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Editing a stored schedule is implemented only on PR #9.',
  },
  {
    operationId: 'pauseSchedule',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Pause and resume state is implemented only on PR #9.',
  },
  {
    operationId: 'resumeSchedule',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Pause and resume state is implemented only on PR #9.',
  },
  {
    operationId: 'getScheduleUpcoming',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Occurrence projection is implemented only on PR #9.',
  },
  {
    operationId: 'listScheduleExecutions',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Occurrence history is implemented only on PR #9.',
  },
  {
    operationId: 'triggerSchedule',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'Manual dispatch is implemented only on PR #9.',
  },
  {
    operationId: 'dispatchScheduleEvent',
    domain: 'scheduling.advanced',
    branch: 'PR #9 (origin/pr/9)',
    head: 'd1f4b505b9aa6f0fa9b90f738e120dc77d5e37ae',
    status: 'blocked',
    reason: 'The event dispatcher is implemented only on PR #9.',
  },
  {
    operationId: 'markNotificationRead',
    domain: 'notifications',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'markNotificationsRead',
    reason: 'Plural batch acknowledgement is the published shape; the singular id would be a second name for one behaviour.',
  },
  {
    operationId: 'writeMemory',
    domain: 'memory',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'putMemory',
    reason: '`putMemory` is the published exact key/value write.',
  },
  {
    operationId: 'controlSchedule',
    domain: 'scheduling',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'cancelSchedule',
    reason: 'Cancellation is the only control the base implementation supports; a generic control id would advertise unimplemented pause and resume.',
  },
  {
    operationId: 'createArtifact',
    domain: 'artifacts',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'uploadTaskArtifact',
    reason: 'Artifacts are task-scoped in the base implementation; a standalone create has no owner and no task.',
  },
  {
    operationId: 'listArtifacts',
    domain: 'artifacts',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'superseded',
    canonical: 'listTaskArtifacts',
    reason: 'The published listing is scoped to the task that produced the bytes.',
  },
  {
    operationId: 'deleteMemory',
    domain: 'memory',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'blocked',
    reason: 'Deletion is not implemented on this base; publishing it would be a simulated capability.',
  },
  {
    operationId: 'searchMemory',
    domain: 'memory',
    branch: 'PR #7 (origin/pr/7)',
    head: '9b4cb5ce4f8688cf232d006028e5e255eda6cb1f',
    status: 'blocked',
    reason: 'Only exact-key memory exists on this base; search is a different operation.',
  },
]);
