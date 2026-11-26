import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { ExecutionEvent } from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import {
  OWNER_ID,
  OWNER_TOKEN,
  baseConfig,
  createWorkspaces,
  fakeGateway,
  waitFor,
  type TestWorkspace,
} from '../helpers.js';

/**
 * Real MongoDB, two engine replicas.
 *
 * This suite is skipped unless `CODERAX_TEST_MONGODB_URI` points at a running
 * server. That is deliberate: a fake collection proves the query shape, not that
 * a unique index arbitrates two processes. Every claim below is made against one
 * real database with two independently composed applications, each with its own
 * driver connection and its own workspace root.
 *
 * It also records the boundaries that are *not* durable yet, with assertions
 * that will fail when the owning branch lands:
 * - execution events replay only inside the process that published them
 *   (`durableEvents` is `unconfigured`);
 * - artifact metadata is shared, artifact bytes are still on the writing
 *   replica's workspace;
 * - the daily inference budget is a process-local ledger, so two replicas each
 *   enforce their own copy until PR #4's durable quota lands.
 */

const MONGO_URI = process.env.CODERAX_TEST_MONGODB_URI?.trim() ?? '';
const MONGO_DATABASE = 'coderax_live_test';
const skip =
  MONGO_URI.length === 0
    ? 'set CODERAX_TEST_MONGODB_URI to a running MongoDB to run the durability suite'
    : false;

type Replica = {
  app: Application;
  url: string;
  api: CoderaxClient;
  workspace: TestWorkspace;
  close: () => Promise<void>;
};

function uniquePrefix(): string {
  return `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function startReplica(prefix: string): Promise<Replica> {
  const workspace = createWorkspaces();
  const config = baseConfig(workspace, {
    schedules: { enabled: false },
    persistence: {
      driver: 'mongo',
      uriEnv: 'CODERAX_TEST_MONGODB_URI',
      database: MONGO_DATABASE,
      collectionPrefix: prefix,
    },
  });
  const app = await composeApplication({
    config,
    env: {
      CODERAX_OWNER_TOKEN: OWNER_TOKEN,
      CODERAX_TEST_MONGODB_URI: MONGO_URI,
    },
    gateway: fakeGateway(),
  });
  const { url } = await app.start();
  return {
    app,
    url,
    api: new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN }),
    workspace,
    close: async () => {
      await app.stop();
      workspace.cleanup();
    },
  };
}

async function dropPrefix(prefix: string): Promise<void> {
  if (MONGO_URI.length === 0) return;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  try {
    const database = client.db(MONGO_DATABASE);
    const collections = await database.listCollections().toArray();
    await Promise.all(
      collections
        .filter((collection) => collection.name.startsWith(prefix))
        .map((collection) => database.dropCollection(collection.name).catch(() => undefined)),
    );
  } finally {
    await client.close();
  }
}

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

test(
  'two replicas arbitrate one idempotent submission over real MongoDB',
  { skip },
  async () => {
    const prefix = uniquePrefix();
    const left = await startReplica(prefix);
    const right = await startReplica(prefix);
    try {
      const request = {
        objective: 'One durable release job, submitted twice',
        mode: 'cloud' as const,
        agent: 'coderax' as const,
        requireApproval: true,
        idempotencyKey: `live-duplicate-${prefix}`,
      };
      const [first, second] = await Promise.all([
        left.api.submitWork(request),
        right.api.submitWork(request),
      ]);
      assert.equal(second.taskId, first.taskId, 'the reservation must arbitrate both replicas');

      const leftTasks = await left.api.tasks();
      const rightTasks = await right.api.tasks();
      assert.equal(leftTasks.total, 1, 'one task row in the shared collection');
      assert.equal(rightTasks.total, 1);

      const completed = await waitFor(async () => {
        const current = await right.api.task(first.taskId);
        return current.state === 'completed' ? current : null;
      });
      assert.equal(completed.generation, 1);

      const leftConversation = await left.api.conversation(first.conversationId);
      const rightConversation = await right.api.conversation(first.conversationId);
      assert.equal(leftConversation.messages.length, 2);
      assert.equal(rightConversation.messages.length, 2, 'the transcript is shared, not per replica');

      const leftNotifications = await left.api.notifications();
      const rightNotifications = await right.api.notifications();
      assert.equal(leftNotifications.unread, 1);
      assert.equal(rightNotifications.unread, 1);

      const markedOnRight = await right.api.markNotificationsRead([first.taskId]);
      assert.equal(markedOnRight.unread, 0);
      assert.equal(
        (await left.api.notifications()).unread,
        0,
        'an acknowledgement on one replica is visible on the other',
      );
    } finally {
      await left.close();
      await right.close();
      await dropPrefix(prefix);
    }
  },
);

test(
  'a restarted replica reads durable tasks, approvals, schedules, memory and artifact metadata',
  { skip },
  async () => {
    const prefix = uniquePrefix();
    const before = await startReplica(prefix);
    let taskId = '';
    let conversationId = '';
    let artifactId = '';
    let permissionId = '';
    let scheduleId = '';
    const artifactText = 'durable artifact bytes';

    try {
      const accepted = await before.api.submitWork({
        objective: 'Survive the engine restart',
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
      });
      taskId = accepted.taskId;
      conversationId = accepted.conversationId;
      await waitFor(async () => {
        const current = await before.api.task(taskId);
        return current.state === 'completed' ? current : null;
      });

      await before.api.putMemory({ key: 'release', value: 'v1.1.0', mode: 'private' });

      const permission = await before.app.dependencies.permissions.request({
        ownerId: OWNER_ID,
        taskId,
        agent: 'coderax',
        scope: 'workspace.read',
        description: 'Read the release notes',
        resource: 'release-notes.md',
      });
      permissionId = permission.requestId;

      const schedule = await before.api.createSchedule({
        objective: 'A schedule that outlives its creating replica',
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
      });
      scheduleId = schedule.scheduleId;

      const artifact = await before.api.uploadArtifact(taskId, {
        path: 'release/notes.txt',
        mediaType: 'text/plain',
        contentBase64: Buffer.from(artifactText).toString('base64'),
      });
      artifactId = artifact.artifactId;
      assert.equal(artifact.digest, sha256(artifactText));
      const content = await before.api.artifactContent(artifactId);
      assert.equal(Buffer.from(content.contentBase64, 'base64').toString('utf8'), artifactText);
    } finally {
      await before.close();
    }

    const after = await startReplica(prefix);
    try {
      const task = await after.api.task(taskId);
      assert.equal(task.state, 'completed');
      assert.equal(task.generation, 1);

      const conversation = await after.api.conversation(conversationId);
      assert.equal(conversation.messages.length, 2);

      const memory = await after.api.memory('private');
      assert.ok(memory.entries.some((entry) => entry.key === 'release'));

      const notifications = await after.api.notifications();
      assert.ok(notifications.notifications.some((entry) => entry.taskId === taskId));
      assert.equal((await after.api.markNotificationsRead([taskId])).unread, 0);

      const permissions = await after.api.permissions(taskId);
      assert.equal(permissions.requests[0]?.requestId, permissionId);
      const decided = await after.api.decidePermission(taskId, {
        requestId: permissionId,
        decision: 'approved',
      });
      assert.equal(decided.requests[0]?.decision, 'approved');

      const schedules = await after.api.schedules();
      assert.equal(schedules.schedules[0]?.scheduleId, scheduleId);
      const cancelled = await after.api.cancelSchedule(scheduleId);
      assert.equal(cancelled.outcome, 'accepted');

      const artifact = await after.api.artifact(artifactId);
      assert.equal(artifact.digest, sha256(artifactText));
      const listed = await after.api.artifacts(taskId);
      assert.ok(listed.artifacts.some((entry) => entry.artifactId === artifactId));
      await assert.rejects(
        () => after.api.artifactContent(artifactId),
        (error: unknown) =>
          error instanceof CoderaxApiError &&
          error.code === 'not_found' &&
          error.status === 404,
        'artifact bytes are still replica-local; the durable artifact service owns sharing them',
      );

      const handshake = await after.api.negotiate();
      assert.equal(
        handshake.capabilities.durableEvents.state,
        'unconfigured',
        'persistent event storage is still owned by feat/durable-events-integration',
      );
      const replayAbort = new AbortController();
      const stopReplay = setTimeout(() => replayAbort.abort(), 500);
      const replayed: ExecutionEvent[] = [];
      try {
        const stream = await after.api.openEvents(taskId, {
          after: 0,
          signal: replayAbort.signal,
        });
        for await (const event of stream.events) replayed.push(event);
      } catch (error) {
        const aborted =
          error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        if (!aborted) throw error;
      } finally {
        clearTimeout(stopReplay);
      }
      assert.deepEqual(
        replayed,
        [],
        'a second process cannot replay events it did not publish; this assertion changes when durable events lands',
      );
    } finally {
      await after.close();
      await dropPrefix(prefix);
    }
  },
);
