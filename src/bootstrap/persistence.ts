import type { EngineConfig } from '../configuration/schema.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { LeaseStore } from '../execution/lease.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { MemoryStore } from '../memory/store.js';
import type { PermissionStore } from '../permissions/store.js';
import type { ScheduleRepository } from '../persistence/schedules.js';
import type { ArtifactRepository } from '../artifacts/store.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../persistence/work-runs.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../persistence/mongo.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { createMongoConnector, MongoUnavailableError } from '../persistence/mongo-connect.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createTaskRepository } from '../persistence/tasks.js';
import { createConversationRepository } from '../persistence/conversations.js';
import { createNotificationStore } from '../persistence/notifications.js';
import { createMemoryStore } from '../memory/store.js';
import { createMediaStore } from '../media/store.js';
import type { MediaStore } from '../media/store.js';
import { createMongoMediaStore, ensureMediaIndexes } from '../persistence/mongo-media.js';
import { createPermissionTable } from '../persistence/permissions.js';
import { createPermissionStore } from '../permissions/store.js';
import { createScheduleRepository } from '../persistence/schedules.js';
import { createArtifactRepository } from '../artifacts/store.js';
import {
  createMongoArtifactRepository,
  createMongoPermissionTable,
  createMongoScheduleRepository,
  ensureArtifactIndexes,
  ensurePermissionIndexes,
  ensureScheduleIndexes,
} from '../persistence/mongo-records.js';
import {
  createMongoConversationRepository,
  createMongoMemoryStore,
  createMongoNotificationStore,
  createMongoTaskRepository,
  ensureConversationIndexes,
  ensureIdempotencyIndexes,
  ensureMemoryIndexes,
  ensureNotificationIndexes,
  ensureTaskIndexes,
} from '../persistence/mongo-tables.js';
import { StartupError } from './startup-error.js';

export type PersistenceStores = {
  driver: 'memory' | 'mongo';
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  notifications: NotificationStore;
  media: MediaStore;
  permissions: PermissionStore;
  schedules: ScheduleRepository;
  artifacts: ArtifactRepository;
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
 * notifications, permissions, schedules and artifacts on restart. `mongo` is the
 * production path; selecting it without a reachable, indexable database is a
 * startup failure, never a silent downgrade. The stores are returned together so
 * the composition root cannot mix a durable lease with a process-local task
 * record, which would make fencing meaningless after a restart, or a durable task
 * with a permission that vanishes on restart.
 */
export async function buildPersistence(input: PersistenceInput): Promise<PersistenceStores> {
  const { config, clock, ids } = input;
  const settings = config.persistence;

  if (settings.driver === 'memory') {
    return {
      driver: 'memory',
      lease: createLeaseStore(createInMemoryWorkRunTable()),
      tasks: createTaskRepository(),
      conversations: createConversationRepository(),
      memory: createMemoryStore({ clock, maxValueLength: MEMORY_VALUE_LIMIT }),
      notifications: createNotificationStore(),
      media: createMediaStore(),
      permissions: createPermissionStore({
        clock,
        ids,
        table: createPermissionTable(),
      }),
      schedules: createScheduleRepository(),
      artifacts: createArtifactRepository(),
      close: NO_CLOSE,
    };
  }

  const database = await openDatabase(input);
  const workRuns: MongoCollectionLike = database.collection(collectionName(config, 'work_runs'));
  const tasks = database.collection(collectionName(config, 'tasks'));
  const idempotency = database.collection(collectionName(config, 'idempotency'));
  const conversations = database.collection(collectionName(config, 'conversations'));
  const messages = database.collection(collectionName(config, 'messages'));
  const memory = database.collection(collectionName(config, 'memory'));
  const notifications = database.collection(collectionName(config, 'notifications'));
  const media = database.collection(collectionName(config, 'media'));
  const permissions = database.collection(collectionName(config, 'permissions'));
  const schedules = database.collection(collectionName(config, 'schedules'));
  const artifacts = database.collection(collectionName(config, 'artifacts'));

  try {
    await ensureWorkRunIndexes(workRuns);
    await ensureTaskIndexes(tasks);
    await ensureIdempotencyIndexes(idempotency);
    await ensureConversationIndexes({ conversations, messages });
    await ensureMemoryIndexes(memory);
    await ensureNotificationIndexes(notifications);
    await ensureMediaIndexes(media);
    await ensurePermissionIndexes(permissions);
    await ensureScheduleIndexes(schedules);
    await ensureArtifactIndexes(artifacts);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new StartupError([
      `persistence.driver is mongo but database ${settings.database} is unusable: ${(error as Error).message}`,
    ]);
  }

  return {
    driver: 'mongo',
    lease: createLeaseStore(createMongoWorkRunTable(workRuns)),
    tasks: createMongoTaskRepository(tasks, idempotency),
    conversations: createMongoConversationRepository({ conversations, messages }),
    memory: createMongoMemoryStore({
      collection: memory,
      clock,
      maxValueLength: MEMORY_VALUE_LIMIT,
    }),
    notifications: createMongoNotificationStore(notifications),
    media: createMongoMediaStore(media),
    permissions: createPermissionStore({
      clock,
      ids,
      table: createMongoPermissionTable(permissions),
    }),
    schedules: createMongoScheduleRepository(schedules),
    artifacts: createMongoArtifactRepository(artifacts),
    close: database.close,
  };
}
