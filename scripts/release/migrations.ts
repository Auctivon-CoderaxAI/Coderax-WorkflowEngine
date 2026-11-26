import type { Migration } from './manifest.js';

/**
 * The database requirements the release matrix publishes. These are the exact
 * indexes `ensureWorkRunIndexes` creates; a unit test asserts that coupling, so
 * a matrix row cannot claim a migration the engine does not apply.
 */
export const DATABASE_MIGRATIONS: readonly Migration[] = Object.freeze<Migration[]>([
  {
    id: 'mongo.work_runs.key',
    collection: 'work_runs',
    operation: 'createIndex',
    keys: { key: 1 },
    unique: true,
    name: 'work_run_key',
    required: true,
    reversible: true,
    rollback: 'drop the work_run_key index; lease rows remain readable',
  },
  {
    id: 'mongo.work_runs.expiry',
    collection: 'work_runs',
    operation: 'createIndex',
    keys: { expiresAt: 1 },
    unique: false,
    name: 'work_run_expires',
    required: true,
    reversible: true,
    rollback: 'drop the work_run_expires index; no data is deleted',
  },
]);
