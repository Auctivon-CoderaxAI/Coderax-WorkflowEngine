import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { ScheduleExecutionRecord } from '../../src/domain.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import {
  createMongoScheduleRepository,
  ensureScheduleIndexes,
} from '../../src/persistence/mongo-schedules.js';

/**
 * Real MongoDB only.
 *
 * Duplicate prevention is a property of the database, not of an in-process
 * guard: two replicas race the same due occurrence and the unique
 * `executionKey` index lets exactly one insert win. A fake store cannot prove
 * that, so this suite opens two independent connections to a real server.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI;
const required = process.env.CODERAX_REQUIRE_MONGO === '1';
const databaseName = `coderax_ci_schedule_${process.pid}_${Date.now()}`;

function requiresDatabase(): void {
  assert.ok(
    uri,
    'CODERAX_TEST_MONGO_URI must name a reachable MongoDB; set CODERAX_REQUIRE_MONGO=1 in CI',
  );
}

function occurrence(): ScheduleExecutionRecord {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    executionId: 'exec_live_once',
    executionKey: 'sched_live_once#2026-01-01T00:00:00.000Z',
    scheduleId: 'sched_live_once',
    ownerId: 'owner-live',
    occurrenceKey: '2026-01-01T00:00:00.000Z',
    trigger: 'schedule',
    scheduledFor: at,
    state: 'claimed',
    attempt: 1,
    maxAttempts: 1,
    taskId: null,
    conversationId: 'conv_live_once',
    priority: 5,
    detail: null,
    nextAttemptAt: null,
    condition: 'not_evaluated',
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  };
}

test(
  'two real connections cannot create the same scheduled occurrence twice',
  { skip: uri ? false : required ? false : 'CODERAX_TEST_MONGO_URI is not set' },
  async () => {
    requiresDatabase();
    const connector = createMongoConnector();
    const first = await connector({ uri: uri as string, database: databaseName });
    try {
      const schedules = first.collection('live_schedules');
      const executions = first.collection('live_schedule_executions');
      await ensureScheduleIndexes({
        schedules,
        executions,
        notices: first.collection('live_schedule_notices'),
      });

      const second = await connector({ uri: uri as string, database: databaseName });
      try {
        const a = createMongoScheduleRepository({ schedules, executions });
        const b = createMongoScheduleRepository({
          schedules: second.collection('live_schedules'),
          executions: second.collection('live_schedule_executions'),
        });

        const record = occurrence();
        const [left, right] = await Promise.all([
          a.createExecution(record),
          b.createExecution(record),
        ]);
        assert.equal([left.created, right.created].filter(Boolean).length, 1);
        assert.equal(left.execution.executionKey, right.execution.executionKey);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      const client = new MongoClient(uri as string);
      try {
        await client.connect();
        await client.db(databaseName).dropDatabase();
      } finally {
        await client.close();
      }
    }
  },
);
