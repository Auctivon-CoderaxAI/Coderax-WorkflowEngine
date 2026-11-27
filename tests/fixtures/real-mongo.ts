/**
 * A real MongoDB server for integration tests, never the driver fake.
 *
 * It prefers an explicitly supplied deployment. Otherwise it starts a real
 * mongod through the optional test-only `mongodb-memory-server` package. If
 * neither is available the caller skips with a reason. A skip is not evidence
 * that durability works, so `CODERAX_REQUIRE_MONGODB=1` turns the absence into a
 * failure for a CI lane that must enforce the real-database check.
 */
export type RealMongo = {
  uri: string;
  describe: string;
  stop: () => Promise<void>;
};

export const REAL_MONGO_SKIP =
  'No real MongoDB: set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.';

export async function startRealMongo(): Promise<RealMongo | null> {
  const configured = process.env.CODERAX_TEST_MONGODB_URI?.trim();
  if (configured) {
    return {
      uri: configured,
      describe: 'CODERAX_TEST_MONGODB_URI',
      stop: async () => undefined,
    };
  }

  const specifier = 'mongodb-memory-server';
  try {
    const module = (await import(specifier)) as {
      MongoMemoryServer: {
        create: (options?: unknown) => Promise<{
          getUri: () => string;
          stop: () => Promise<boolean>;
        }>;
      };
    };
    const server = await module.MongoMemoryServer.create();
    return {
      uri: server.getUri(),
      describe: 'mongodb-memory-server (real mongod)',
      stop: async () => {
        await server.stop();
      },
    };
  } catch {
    return null;
  }
}

export function requireRealMongo(real: RealMongo | null): void {
  if (real === null && process.env.CODERAX_REQUIRE_MONGODB === '1') {
    throw new Error(
      'CODERAX_REQUIRE_MONGODB=1 but no real MongoDB is available; set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.',
    );
  }
}
