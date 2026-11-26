import type { EngineConfig } from '../configuration/schema.js';
import type { Clock } from '../support/clock.js';
import type { LeaseStore } from '../execution/lease.js';
import type { BudgetStore } from '../models/budget.js';
import { createMemoryBudgetStore } from '../models/budget.js';
import {
  budgetReservationCollection,
  budgetWindowCollection,
  createMongoBudgetStore,
  ensureBudgetIndexes,
} from '../persistence/budgets.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { MemoryStore } from '../memory/store.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../persistence/work-runs.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../persistence/mongo.js';
import type { EventLog } from '../events/log.js';
import { createInMemoryEventLog } from '../events/log.js';
import { createMongoEventLog, ensureEventIndexes } from '../persistence/mongo-events.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { createMongoConnector, MongoUnavailableError } from '../persistence/mongo-connect.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createTaskRepository } from '../persistence/tasks.js';
import { createConversationRepository } from '../persistence/conversations.js';
import { createNotificationStore } from '../persistence/notifications.js';
import { createMemoryStore } from '../memory/store.js';
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

export type PersistenceStores = {
  driver: 'memory' | 'mongo';
  permissionCollection?: MongoCollectionLike;
  /** Durable request and token budget windows, shared by every replica. */
  budgets: BudgetStore;
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  notifications: NotificationStore;
  /**
   * The durable ordered event log. It is built here, next to the task record,
   * because a settlement guarantee is only true when both are on the same
   * durability tier: a durable task cannot point at a process-local stream.
   */
  events: EventLog;
  close: () => Promise<void>;
};

export type PersistenceInput = {
  config: EngineConfig;
  env: NodeJS.ProcessEnv;
  clock: Clock;
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
 * `memory` is a single process and forgets tasks, transcripts, memory and
 * notifications on restart. `mongo` is the production path; selecting it without
 * a reachable, indexable database is a startup failure, never a silent downgrade.
 * The stores are returned together so the composition root cannot mix a durable
 * lease with a process-local task record, which would make fencing meaningless
 * after a restart.
 */
export async function buildPersistence(input: PersistenceInput): Promise<PersistenceStores> {
  const { config, clock } = input;
  const settings = config.persistence;

  if (settings.driver === 'memory') {
    return {
      driver: 'memory',
      budgets: createMemoryBudgetStore(),
      lease: createLeaseStore(createInMemoryWorkRunTable()),
      tasks: createTaskRepository(),
      conversations: createConversationRepository(),
      memory: createMemoryStore({ clock, maxValueLength: MEMORY_VALUE_LIMIT }),
      notifications: createNotificationStore(),
      events: createInMemoryEventLog({ bufferSize: config.execution.eventBufferSize }),
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
  const events = database.collection(collectionName(config, 'events'));
  const eventHeads = database.collection(collectionName(config, 'event_heads'));

  const permissionCollection = database.collection(collectionName(config, 'permissions'));
  const budgetWindows = database.collection(budgetWindowCollection(config.persistence.collectionPrefix));
  const budgetReservations = database.collection(
    budgetReservationCollection(config.persistence.collectionPrefix),
  );
  try {
    await permissionCollection.createIndex({ requestId: 1 }, { unique: true, name: 'permission_request' });
    await permissionCollection.createIndex({ ownerId: 1, taskId: 1 }, { name: 'permission_task' });
    await ensureBudgetIndexes({ windows: budgetWindows, reservations: budgetReservations });
    await ensureWorkRunIndexes(workRuns);
    await ensureTaskIndexes(tasks);
    await ensureConversationIndexes({ conversations, messages });
    await ensureMemoryIndexes(memory);
    await ensureNotificationIndexes(notifications);
    await ensureEventIndexes({ events, heads: eventHeads });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new StartupError([
      `persistence.driver is mongo but database ${settings.database} is unusable: ${(error as Error).message}`,
    ]);
  }

  return {
    driver: 'mongo',
    permissionCollection,
    budgets: createMongoBudgetStore({ windows: budgetWindows, reservations: budgetReservations }),
    lease: createLeaseStore(createMongoWorkRunTable(workRuns)),
    tasks: createMongoTaskRepository(tasks),
    conversations: createMongoConversationRepository({ conversations, messages }),
    memory: createMongoMemoryStore({
      collection: memory,
      clock,
      maxValueLength: MEMORY_VALUE_LIMIT,
    }),
    notifications: createMongoNotificationStore(notifications),
    events: createMongoEventLog({ events, heads: eventHeads }),
    close: database.close,
  };
}
