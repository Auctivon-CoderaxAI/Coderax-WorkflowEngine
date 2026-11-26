/**
 * A real MongoDB deployment for integration tests, never the driver fake.
 *
 * The connection string comes from `CODERAX_TEST_MONGODB_URI`; the verify
 * workflow points it at a MongoDB service container. A local run without a
 * server skips with this reason instead of quietly reporting durability as
 * passing. `CODERAX_REQUIRE_MONGODB=1` turns the absence into a failure, which
 * is what the CI lane sets so a lost service cannot produce a green skip.
 */
export type RealMongo = {
  uri: string;
};

export const REAL_MONGO_SKIP =
  'No real MongoDB: set CODERAX_TEST_MONGODB_URI to a reachable server.';

export function configuredMongo(): RealMongo | null {
  const uri = process.env.CODERAX_TEST_MONGODB_URI?.trim();
  return uri ? { uri } : null;
}

export function requireRealMongo(real: RealMongo | null): void {
  if (real === null && process.env.CODERAX_REQUIRE_MONGODB === '1') {
    throw new Error(
      'CODERAX_REQUIRE_MONGODB=1 but CODERAX_TEST_MONGODB_URI is not set; the real-database lane must not skip.',
    );
  }
}
