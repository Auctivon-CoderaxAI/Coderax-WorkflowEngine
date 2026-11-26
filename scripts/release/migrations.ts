import type { Migration } from './manifest.js';

/**
 * The database requirements the release matrix publishes.
 *
 * Every row corresponds to one `createIndex` call in the engine's
 * `ensure*Indexes` functions, across every collection the persistence layer
 * writes. `tests/release/evidence.test.ts` executes those functions against the
 * driver fake and fails if this list and the engine disagree, so a newly added
 * index cannot ship undeclared. Row `id` and `name` are the stable identifiers a
 * deployment tool should use; `collection` is the unprefixed base name because
 * the operator configures `persistence.collectionPrefix`.
 */
function indexMigration(input: {
  id: string;
  collection: string;
  keys: Record<string, 1 | -1>;
  name: string;
  unique?: boolean;
  rollback?: string;
}): Migration {
  return {
    id: input.id,
    collection: input.collection,
    operation: 'createIndex',
    keys: input.keys,
    unique: input.unique ?? false,
    name: input.name,
    required: true,
    reversible: true,
    rollback: input.rollback ?? `drop the ${input.name} index; no data is deleted`,
  };
}

export const DATABASE_MIGRATIONS: readonly Migration[] = Object.freeze<Migration[]>([
  indexMigration({
    id: 'mongo.work_runs.key',
    collection: 'work_runs',
    keys: { key: 1 },
    unique: true,
    name: 'work_run_key',
    rollback: 'drop the work_run_key index; lease rows remain readable',
  }),
  indexMigration({
    id: 'mongo.work_runs.expiry',
    collection: 'work_runs',
    keys: { expiresAt: 1 },
    name: 'work_run_expires',
  }),
  indexMigration({
    id: 'mongo.tasks.id',
    collection: 'tasks',
    keys: { taskId: 1 },
    unique: true,
    name: 'task_id',
    rollback: 'drop the task_id index; task rows remain readable by other indexes',
  }),
  indexMigration({
    id: 'mongo.tasks.conversation_state',
    collection: 'tasks',
    keys: { conversationId: 1, state: 1 },
    name: 'task_conversation_state',
  }),
  indexMigration({
    id: 'mongo.tasks.owner',
    collection: 'tasks',
    keys: { ownerId: 1 },
    name: 'task_owner',
  }),
  indexMigration({
    id: 'mongo.idempotency.key',
    collection: 'idempotency',
    keys: { key: 1 },
    unique: true,
    name: 'idempotency_key',
    rollback: 'drop the idempotency_key index; stored idempotency rows remain',
  }),
  indexMigration({
    id: 'mongo.idempotency.created',
    collection: 'idempotency',
    keys: { createdAt: 1 },
    name: 'idempotency_created',
  }),
  indexMigration({
    id: 'mongo.conversations.id',
    collection: 'conversations',
    keys: { conversationId: 1 },
    unique: true,
    name: 'conversation_id',
    rollback: 'drop the conversation_id index; conversation rows remain readable',
  }),
  indexMigration({
    id: 'mongo.conversations.owner_updated',
    collection: 'conversations',
    keys: { ownerId: 1, updatedAt: -1 },
    name: 'conversation_owner_updated',
  }),
  indexMigration({
    id: 'mongo.messages.id',
    collection: 'messages',
    keys: { messageId: 1 },
    unique: true,
    name: 'message_id',
    rollback: 'drop the message_id index; message rows remain readable',
  }),
  indexMigration({
    id: 'mongo.messages.conversation_created',
    collection: 'messages',
    keys: { conversationId: 1, createdAt: 1 },
    name: 'message_conversation_created',
  }),
  indexMigration({
    id: 'mongo.memory.partition',
    collection: 'memory',
    keys: { ownerId: 1, mode: 1, key: 1 },
    unique: true,
    name: 'memory_partition',
    rollback: 'drop the memory_partition index; memory rows remain readable',
  }),
  indexMigration({
    id: 'mongo.notifications.task',
    collection: 'notifications',
    keys: { taskId: 1 },
    unique: true,
    name: 'notification_task',
    rollback: 'drop the notification_task index; notification rows remain readable',
  }),
  indexMigration({
    id: 'mongo.notifications.owner_created',
    collection: 'notifications',
    keys: { ownerId: 1, createdAt: -1 },
    name: 'notification_owner_created',
  }),
  indexMigration({
    id: 'mongo.permissions.request',
    collection: 'permissions',
    keys: { requestId: 1 },
    unique: true,
    name: 'permission_request',
    rollback: 'drop the permission_request index; permission rows remain readable',
  }),
  indexMigration({
    id: 'mongo.permissions.task',
    collection: 'permissions',
    keys: { ownerId: 1, taskId: 1, requestedAt: 1 },
    name: 'permission_task',
  }),
  indexMigration({
    id: 'mongo.permissions.pending',
    collection: 'permissions',
    keys: { ownerId: 1, decision: 1 },
    name: 'permission_pending',
  }),
  indexMigration({
    id: 'mongo.schedules.id',
    collection: 'schedules',
    keys: { scheduleId: 1 },
    unique: true,
    name: 'schedule_id',
    rollback: 'drop the schedule_id index; schedule rows remain readable',
  }),
  indexMigration({
    id: 'mongo.schedules.due',
    collection: 'schedules',
    keys: { state: 1, nextRunAt: 1 },
    name: 'schedule_due',
  }),
  indexMigration({
    id: 'mongo.schedules.owner',
    collection: 'schedules',
    keys: { ownerId: 1, createdAt: -1 },
    name: 'schedule_owner',
  }),
  indexMigration({
    id: 'mongo.artifacts.id',
    collection: 'artifacts',
    keys: { artifactId: 1 },
    unique: true,
    name: 'artifact_id',
    rollback: 'drop the artifact_id index; artifact metadata remains readable',
  }),
  indexMigration({
    id: 'mongo.artifacts.task',
    collection: 'artifacts',
    keys: { ownerId: 1, taskId: 1, createdAt: 1 },
    name: 'artifact_task',
  }),
  indexMigration({
    id: 'mongo.events.task_seq',
    collection: 'events',
    keys: { taskId: 1, seq: 1 },
    unique: true,
    name: 'event_task_seq',
    rollback: 'drop the event_task_seq index; stored events remain readable',
  }),
  indexMigration({
    id: 'mongo.events.task_id',
    collection: 'events',
    keys: { taskId: 1, eventId: 1 },
    unique: true,
    name: 'event_task_id',
    rollback: 'drop the event_task_id index; stored events remain readable',
  }),
  indexMigration({
    id: 'mongo.events.task_tail',
    collection: 'events',
    keys: { taskId: 1, seq: -1 },
    name: 'event_task_tail',
  }),
  indexMigration({
    id: 'mongo.event_heads.task',
    collection: 'event_heads',
    keys: { taskId: 1 },
    unique: true,
    name: 'event_head_task',
    rollback: 'drop the event_head_task index; generation head rows remain readable',
  }),
]);
