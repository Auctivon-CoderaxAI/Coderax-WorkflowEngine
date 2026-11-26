import type { EngineConfig } from '../configuration/schema.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { LeaseStore } from '../execution/lease.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { MemoryStore } from '../memory/store.js';
import type { PermissionStore } from '../permissions/store.js';
import type { AuditLog } from '../observability/audit.js';
import type { CheckpointStore } from '../persistence/checkpoints.js';
import type { IdempotencyStore } from '../persistence/idempotency.js';
import type { EventLog } from '../events/log.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../persistence/work-runs.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../persistence/mongo.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { createMongoConnector, MongoUnavailableError } from '../persistence/mongo-connect.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createTaskRepository } from '../persistence/tasks.js';
import { createConversationRepository } from '../persistence/conversations.js';
import { createNotificationStore } from '../persistence/notifications.js';
import { createMemoryStore } from '../memory/store.js';
import { createMemoryEventLog } from '../events/log.js';
import { createMongoEventLog, ensureEventIndexes } from '../persistence/mongo-events.js';
import { createPermissionStore, ensurePermissionIndexes } from '../permissions/store.js';
import { createAuditLog } from '../observability/audit.js';
import { createMongoAuditLog, ensureAuditIndexes } from '../persistence/mongo-audit.js';
import {
  createCheckpointStore,
  createMongoCheckpointStore,
  ensureCheckpointIndexes,
} from '../persistence/checkpoints.js';
import {
  createIdempotencyStore,
  createMongoIdempotencyStore,
  ensureIdempotencyIndexes,
} from '../persistence/idempotency.js';
import {
  createMongoConversationRepository,
  createMongoMemoryStore,
  createMongoNotificationStore,
  createMongoTaskRepository,
  ensureConversationIndexes,
  ensureMemoryIndexes,
  ensureNotificationIndexes,
  ensureTaskIndexes,
} from '../persistence/mongo-tables.js';
import { StartupError } from './startup-error.js';

export type PersistenceHealth = {
  driver: 'memory' | 'mongo';
  /** False for the process-local driver: it works, but a restart erases it. */
  durable: boolean;
  ok: boolean;
  latencyMs: number;
  detail: string;
};

export type PersistenceStores = {
  driver: 'memory' | 'mongo';
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  notifications: NotificationStore;
  permissions: PermissionStore;
  audit: AuditLog;
  checkpoints: CheckpointStore;
  idempotency: IdempotencyStore;
  /** Durable execution events; the payload side of the event stream. */
  events: EventLog;
  ping: () => Promise<PersistenceHealth>;
  close: () => Promise<void>;
};

export type PersistenceInput = {
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  ids: IdGenerator;
  /** An opened database from a test, or from a host that owns its own driver. */
  database?: MongoDatabase;
  /** Replaces the driver loader; the default imports `mongodb` at startup. */
  connect?: MongoConnector;
};

const NO_CLOSE = async (): Promise<void> => undefined;

const MEMORY_VALUE_LIMIT = 20_000;

function collectionName(config: EngineConfig, base: string): string {
  return `${config.persistence.collectionPrefix}${base}`;
}

async function openDatabase(input: PersistenceInput): Promise<MongoDatabase> {
  if (input.database) return input.database;

  const settings = input.config.persistence;
  const uri = input.env[settings.uriEnv]?.trim();
  if (!uri) {
    throw new StartupError([
      `persistence.driver is mongo but ${settings.uriEnv} is not set; set it or select persistence.driver=memory`,
    ]);
  }

  const connect = input.connect ?? createMongoConnector();
  try {
    return await connect({ uri, database: settings.database });
  } catch (error) {
    throw new StartupError([
      error instanceof MongoUnavailableError
        ? error.message
        : `persistence.driver is mongo but database ${settings.database} could not be opened: ${(error as Error).message}`,
    ]);
  }
}

/**
 * Builds every store from the validated persistence setting.
 *
 * `memory` is a single process and forgets tasks, transcripts, memory,
 * notifications, receipts and idempotency records on restart. `mongo` is the
 * production path; selecting it without a reachable, indexable database is a
 * startup failure, never a silent downgrade. The stores are returned together so
 * the composition root cannot mix a durable lease with a process-local task
 * record, which would make fencing meaningless after a restart.
 */
export async function buildPersistence(input: PersistenceInput): Promise<PersistenceStores> {
  const { config, clock, ids } = input;
  const settings = config.persistence;

  if (settings.driver === 'memory') {
    const ping = async (): Promise<PersistenceHealth> => ({
      driver: 'memory',
      durable: false,
      ok: true,
      latencyMs: 0,
      detail:
        'Process-local stores are active; a restart loses tasks, transcripts, events, receipts, memory, notifications and idempotency records.',
    });
    return {
      driver: 'memory',
      lease: createLeaseStore(createInMemoryWorkRunTable()),
      tasks: createTaskRepository(),
      conversations: createConversationRepository(),
      memory: createMemoryStore({ clock, maxValueLength: MEMORY_VALUE_LIMIT }),
      notifications: createNotificationStore(),
      permissions: createPermissionStore({ clock, ids }),
      audit: createAuditLog({ clock, ids }),
      checkpoints: createCheckpointStore(),
      idempotency: createIdempotencyStore(),
      events: createMemoryEventLog(),
      ping,
      close: NO_CLOSE,
    };
  }

  const database = await openDatabase(input);
  const workRuns: MongoCollectionLike = database.collection(collectionName(config, 'work_runs'));
  const tasks = database.collection(collectionName(config, 'tasks'));
  const conversations = database.collection(collectionName(config, 'conversations'));
  const messages = database.collection(collectionName(config, 'messages'));
  const memory = database.collection(collectionName(config, 'memory'));
  const notifications = database.collection(collectionName(config, 'notifications'));
  const permissions = database.collection(collectionName(config, 'permissions'));
  const audit = database.collection(collectionName(config, 'audit_receipts'));
  const checkpoints = database.collection(collectionName(config, 'checkpoints'));
  const idempotency = database.collection(collectionName(config, 'idempotency'));
  const events = database.collection(collectionName(config, 'events'));
  const eventHeads = database.collection(collectionName(config, 'event_heads'));

  try {
    await ensureWorkRunIndexes(workRuns);
    await ensureTaskIndexes(tasks);
    await ensureConversationIndexes({ conversations, messages });
    await ensureMemoryIndexes(memory);
    await ensureNotificationIndexes(notifications);
    await ensurePermissionIndexes(permissions);
    await ensureAuditIndexes(audit);
    await ensureCheckpointIndexes(checkpoints);
    await ensureIdempotencyIndexes(idempotency);
    await ensureEventIndexes({ events, heads: eventHeads });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new StartupError([
      `persistence.driver is mongo but database ${settings.database} is unusable: ${(error as Error).message}`,
    ]);
  }

  const ping = async (): Promise<PersistenceHealth> => {
    const started = Date.now();
    try {
      await database.ping();
      return {
        driver: 'mongo',
        durable: true,
        ok: true,
        latencyMs: Date.now() - started,
        detail: `MongoDB ${settings.database} answered a ping.`,
      };
    } catch {
      return {
        driver: 'mongo',
        durable: true,
        ok: false,
        latencyMs: Date.now() - started,
        detail: `MongoDB ${settings.database} did not answer a ping.`,
      };
    }
  };

  return {
    driver: 'mongo',
    lease: createLeaseStore(createMongoWorkRunTable(workRuns)),
    tasks: createMongoTaskRepository(tasks),
    conversations: createMongoConversationRepository({ conversations, messages }),
    memory: createMongoMemoryStore({
      collection: memory,
      clock,
      maxValueLength: MEMORY_VALUE_LIMIT,
    }),
    notifications: createMongoNotificationStore(notifications),
    permissions: createPermissionStore({
      clock,
      ids,
      collection: permissions,
    }),
    audit: createMongoAuditLog({ collection: audit, clock, ids }),
    checkpoints: createMongoCheckpointStore(checkpoints),
    idempotency: createMongoIdempotencyStore(idempotency),
    events: createMongoEventLog({ events, heads: eventHeads }),
    ping,
    close: database.close,
  };
}
