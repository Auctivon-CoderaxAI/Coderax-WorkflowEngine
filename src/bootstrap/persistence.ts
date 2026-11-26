import type { EngineConfig } from '../configuration/schema.js';
import type { Clock } from '../support/clock.js';
import type { LeaseStore } from '../execution/lease.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { MemoryStore } from '../memory/store.js';
import { createLeaseStore, createInMemoryWorkRunTable } from '../persistence/work-runs.js';
import { createMongoWorkRunTable, ensureWorkRunIndexes } from '../persistence/mongo.js';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { createMongoConnector, MongoUnavailableError } from '../persistence/mongo-connect.js';
import type { MongoConnector, MongoDatabase } from '../persistence/mongo-connect.js';
import { createTaskRepository } from '../persistence/tasks.js';
import { createConversationRepository } from '../persistence/conversations.js';
import { createNotificationStore } from '../persistence/notifications.js';
import { createMemoryStore } from '../memory/store.js';
import { createArtifactRepository } from '../persistence/artifacts.js';
import type { ArtifactRepository } from '../persistence/artifacts.js';
import { createInMemoryBlobStore } from '../persistence/blobs.js';
import type { BlobStore } from '../persistence/blobs.js';
import {
  createInMemoryCapacityStore,
  createMongoCapacityStore,
  ensureCapacityIndexes,
} from '../persistence/capacity.js';
import type { CapacityStore } from '../persistence/capacity.js';
import {
  createMongoArtifactRepository,
  createMongoBlobStore,
  ensureArtifactIndexes,
} from '../persistence/mongo-artifacts.js';
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
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  notifications: NotificationStore;
  /** Artifact descriptors and immutable version rows. */
  artifacts: ArtifactRepository;
  /**
   * Content-addressed bytes. The memory driver reports `durable: false`, and the
   * artifact service refuses uploads through it rather than losing them later.
   */
  blobs: BlobStore;
  /** Atomic quota admission and expiring reservations. */
  capacity: CapacityStore;
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
      lease: createLeaseStore(createInMemoryWorkRunTable()),
      tasks: createTaskRepository(),
      conversations: createConversationRepository(),
      memory: createMemoryStore({ clock, maxValueLength: MEMORY_VALUE_LIMIT }),
      notifications: createNotificationStore(),
      artifacts: createArtifactRepository(),
      blobs: createInMemoryBlobStore(),
      capacity: createInMemoryCapacityStore(),
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
  const artifacts = database.collection(collectionName(config, 'artifacts'));
  const artifactVersions = database.collection(collectionName(config, 'artifact_versions'));
  const artifactBlobs = database.collection(collectionName(config, 'artifact_blobs'));
  const artifactChunks = database.collection(collectionName(config, 'artifact_chunks'));
  const artifactCapacity = database.collection(collectionName(config, 'artifact_capacity'));
  const artifactReservations = database.collection(
    collectionName(config, 'artifact_reservations'),
  );
  const artifactCollections = {
    artifacts,
    versions: artifactVersions,
    blobs: artifactBlobs,
    chunks: artifactChunks,
  };

  try {
    await ensureWorkRunIndexes(workRuns);
    await ensureTaskIndexes(tasks);
    await ensureConversationIndexes({ conversations, messages });
    await ensureMemoryIndexes(memory);
    await ensureNotificationIndexes(notifications);
    await ensureArtifactIndexes(artifactCollections);
    await ensureCapacityIndexes({
      capacity: artifactCapacity,
      reservations: artifactReservations,
    });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw new StartupError([
      `persistence.driver is mongo but database ${settings.database} is unusable: ${(error as Error).message}`,
    ]);
  }

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
    artifacts: createMongoArtifactRepository(artifactCollections),
    blobs: createMongoBlobStore({
      collections: { blobs: artifactBlobs, chunks: artifactChunks },
      clock,
      chunkBytes: config.artifacts.chunkBytes,
    }),
    capacity: createMongoCapacityStore({
      capacity: artifactCapacity,
      reservations: artifactReservations,
    }),
    close: database.close,
  };
}
