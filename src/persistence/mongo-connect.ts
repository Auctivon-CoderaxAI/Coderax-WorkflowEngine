import type { MongoCollectionLike } from './mongo.js';

/**
 * Opening the production database.
 *
 * The driver is loaded lazily, by name, so the engine has no startup cost and no
 * hard dependency when `persistence.driver` is `memory`. Selecting `mongo`
 * without the driver installed, without a connection string, or against a server
 * that cannot be reached is a startup failure: a durable deployment never falls
 * back to process-local state, because two replicas would then each believe they
 * own the same conversation and the same task.
 *
 * One connection serves every collection. A per-store connection would multiply
 * the failure surface and make shutdown order observable.
 */

export type MongoDatabase = {
  collection: (name: string) => MongoCollectionLike;
  close: () => Promise<void>;
};

export type MongoConnectionInput = {
  uri: string;
  database: string;
};

export type MongoConnector = (input: MongoConnectionInput) => Promise<MongoDatabase>;

export class MongoUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MongoUnavailableError';
  }
}

type MongoClientLike = {
  connect: () => Promise<void>;
  db: (name: string) => {
    command: (spec: Record<string, unknown>) => Promise<unknown>;
    collection: (name: string) => MongoCollectionLike;
  };
  close: () => Promise<void>;
};

type MongoDriverModule = {
  MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike;
};

/** A connection string can carry credentials; a startup error may not. */
export function describeTarget(uri: string): string {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname.replace(/^\//, '');
    return database.length > 0 ? `${parsed.host}/${database}` : parsed.host;
  } catch {
    return 'the configured MongoDB deployment';
  }
}

async function loadDriver(): Promise<MongoDriverModule> {
  // Held in a variable so the package stays an optional runtime dependency:
  // TypeScript does not resolve it, and the engine never imports it unless
  // MongoDB is selected.
  const specifier = 'mongodb';
  try {
    return (await import(specifier)) as MongoDriverModule;
  } catch {
    throw new MongoUnavailableError(
      "persistence.driver is mongo but the 'mongodb' package is not installed on this host; install it or select persistence.driver=memory",
    );
  }
}

export function createMongoConnector(): MongoConnector {
  return async ({ uri, database }) => {
    const driver = await loadDriver();
    const client = new driver.MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
      const db = client.db(database);
      // Ping before returning: a successful constructor proves nothing, and the
      // index bootstrap that follows must fail on a real server, not on a lazy
      // connection that only fails under the first request.
      await db.command({ ping: 1 });
      return {
        collection: (name) => db.collection(name),
        close: async () => {
          await client.close();
        },
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new MongoUnavailableError(
        `persistence.driver is mongo but ${describeTarget(uri)} is not reachable: ${(error as Error).message}`,
      );
    }
  };
}
