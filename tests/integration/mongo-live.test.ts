import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import type { ExecutionEvent } from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import type { ModelGateway } from '../../src/agents/native/types.js';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector, type MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { createMongoEventLog } from '../../src/persistence/mongo-events.js';
import type { Principal } from '../../src/security/auth.js';
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
 * It also records the boundaries that are still replica-local, with assertions
 * that will fail when the owning branch lands:
 * - artifact metadata is shared, artifact bytes are still on the writing
 *   replica's workspace;
 * - the daily inference budget is a process-local ledger, so two replicas each
 *   enforce their own copy until PR #4's durable quota lands.
 *
 * Execution events are durable: a replica that never ran the task reads the
 * stored stream from `after: 0` and from a mid-stream cursor, including while
 * the owner is still executing it, and the handshake advertises
 * `durableEvents: available` because the log lives in MongoDB. Retention
 * truncation and generation fencing are asserted against the shared
 * collections, not a fake: the second generation is created by the real resume
 * route on the replica that does not own the first.
 */

const MONGO_URI = process.env.CODERAX_TEST_MONGODB_URI?.trim() ?? '';
const MONGO_DATABASE = 'coderax_live_test';
const OWNER: Principal = { ownerId: OWNER_ID, isOwner: true };
const skip =
  MONGO_URI.length === 0
    ? 'set CODERAX_TEST_MONGODB_URI to a running MongoDB to run the durability suite'
    : false;

type Replica = {
  app: Application;
  service: Application['service'];
  url: string;
  api: CoderaxClient;
  workspace: TestWorkspace;
  close: () => Promise<void>;
};

function uniquePrefix(): string {
  return `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function startReplica(
  prefix: string,
  options: { gateway?: ModelGateway } = {},
): Promise<Replica> {
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
    gateway: options.gateway ?? fakeGateway(),
  });
  const { url } = await app.start();
  return {
    app,
    service: app.service,
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

/** A connection of this test's own, the way another replica opens the store. */
async function openLiveDatabase(): Promise<MongoDatabase> {
  return createMongoConnector()({ uri: MONGO_URI, database: MONGO_DATABASE });
}

type ReplayResult = {
  events: ExecutionEvent[];
  lastSeq: number;
  truncated: boolean;
};

/**
 * Reads an event stream to its end. A finished task closes the stream on its
 * terminal event; the timeout is a failure guard, not part of the assertion.
 */
async function replayEvents(
  replica: Replica,
  taskId: string,
  options: { after?: number; lastEventId?: number },
): Promise<ReplayResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const stream = await replica.api.openEvents(taskId, {
      ...options,
      signal: controller.signal,
    });
    const events: ExecutionEvent[] = [];
    for await (const event of stream.events) events.push(event);
    return { events, lastSeq: stream.lastSeq, truncated: stream.truncated };
  } catch (error) {
    const aborted =
      error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    if (!aborted) throw error;
    throw new Error('the durable replay did not close on the task terminal event');
  } finally {
    clearTimeout(timer);
  }
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
        'available',
        'a Mongo-backed replica must advertise durable event replay',
      );
      assert.match(
        handshake.capabilities.durableEvents.detail ?? '',
        /MongoDB/,
        'the capability must name the durable store',
      );

      // The replica that answers this request did not execute the task: the
      // stream can only come from the shared event log.
      const full = await replayEvents(after, taskId, { after: 0 });
      assert.ok(full.events.length >= 3, 'queued, started and completed must be replayed');
      assert.equal(full.events[0]?.type, 'task.queued', 'replay starts at the accepted event');
      assert.equal(full.events.at(-1)?.type, 'task.completed', 'the stream ends at the terminal event');
      assert.ok(
        full.events.every((event) => event.taskId === taskId && event.generation === 1),
        'every replayed event belongs to the task and its one generation',
      );
      assert.equal(full.events[0]?.seq, 1, 'the first sequence number is durable');
      assert.ok(
        full.events.every((event, index) => index === 0 || event.seq > full.events[index - 1]!.seq),
        'replay preserves the durable sequence order',
      );
      assert.equal(full.lastSeq, full.events.at(-1)?.seq, 'the header reports the durable watermark');
      assert.equal(full.truncated, false);

      const midpoint =
        full.events.find((event) => event.type === 'task.started') ??
        full.events[Math.floor(full.events.length / 2)]!;
      const expectedTail = full.events.filter((event) => event.seq > midpoint.seq);
      assert.ok(expectedTail.length > 0, 'the midpoint must leave events in the tail');

      const midTail = await replayEvents(after, taskId, { after: midpoint.seq });
      assert.deepEqual(
        midTail.events.map((event) => event.eventId),
        expectedTail.map((event) => event.eventId),
        'an explicit after cursor resumes mid-stream on the replaying replica',
      );

      const headerTail = await replayEvents(after, taskId, { lastEventId: midpoint.seq });
      assert.deepEqual(
        headerTail.events.map((event) => event.eventId),
        expectedTail.map((event) => event.eventId),
        'Last-Event-ID resumes the same durable cursor',
      );
    } finally {
      await after.close();
      await dropPrefix(prefix);
    }
  },
);

test(
  'a second live replica replays a run the owner is still executing',
  { skip },
  async () => {
    const prefix = uniquePrefix();
    let open: () => void = () => undefined;
    const adapterGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const owner = await startReplica(prefix, {
      gateway: fakeGateway({ beforeReturn: () => adapterGate }),
    });
    const reader = await startReplica(prefix);
    try {
      const accepted = await owner.api.submitWork({
        objective: 'Report the stream before the run settles',
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
      });

      // The reader did not execute this task, so the shared log is the only
      // source for these events, and it is read while the owner is still inside
      // the adapter.
      const midRun = await waitFor(async () => {
        const result = await reader.service.events(OWNER, accepted.taskId, 0);
        if (!result.ok) return null;
        return result.value.replay.events.some((event) => event.type === 'task.started')
          ? result.value
          : null;
      });

      assert.equal((await owner.api.task(accepted.taskId)).state, 'running');
      assert.equal(
        (await reader.api.task(accepted.taskId)).state,
        'running',
        'the reader sees the owner run as running',
      );

      const durablePrefix = midRun.replay.events;
      assert.deepEqual(
        durablePrefix.slice(0, 2).map((event) => event.type),
        ['task.queued', 'task.started'],
        'the accepted and started events are durable before the adapter returns',
      );
      assert.ok(
        durablePrefix.every(
          (event) =>
            !['task.completed', 'task.failed', 'task.cancelled', 'task.interrupted'].includes(
              event.type,
            ),
        ),
        'nothing in the mid-run prefix settles the task',
      );
      assert.equal(midRun.replay.truncated, false);
      assert.equal(midRun.generation, 1);
      assert.equal(
        midRun.lastSeq,
        durablePrefix.at(-1)?.seq,
        'the reported watermark matches the durable prefix',
      );
      assert.ok(
        durablePrefix.every(
          (event) => event.taskId === accepted.taskId && event.generation === 1,
        ),
      );
      const prefixIds = durablePrefix.map((event) => event.eventId);

      open();
      const completed = await waitFor(async () => {
        const current = await reader.api.task(accepted.taskId);
        return current.state === 'completed' ? current : null;
      });
      assert.equal(completed.generation, 1);

      const full = await replayEvents(reader, accepted.taskId, { after: 0 });
      assert.equal(full.events.at(-1)?.type, 'task.completed');
      assert.ok(
        full.events.length > prefixIds.length,
        'the tail was stored after the mid-run read',
      );
      assert.deepEqual(
        full.events.slice(0, prefixIds.length).map((event) => event.eventId),
        prefixIds,
        'the prefix a second replica read mid-run is the prefix it reads afterwards',
      );

      const tail = await replayEvents(reader, accepted.taskId, { after: midRun.lastSeq });
      assert.deepEqual(
        tail.events.map((event) => event.eventId),
        full.events.slice(prefixIds.length).map((event) => event.eventId),
        'a mid-run cursor resumes exactly at the durable watermark',
      );
      assert.equal(tail.events[0]?.seq, midRun.lastSeq + 1);
      assert.equal(tail.truncated, false);

      const owned = await replayEvents(owner, accepted.taskId, { after: 0 });
      assert.deepEqual(
        owned.events.map((event) => event.eventId),
        full.events.map((event) => event.eventId),
        'both replicas read one stream',
      );
    } finally {
      open();
      await owner.close();
      await reader.close();
      await dropPrefix(prefix);
    }
  },
);

test(
  'retention pruning is a gap for a replica that did not write the stream',
  { skip },
  async () => {
    const prefix = uniquePrefix();
    const writer = await startReplica(prefix);
    const reader = await startReplica(prefix);
    let database: MongoDatabase | null = null;
    try {
      const accepted = await writer.api.submitWork({
        objective: 'A stream that can only keep its newest events',
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
      });
      await waitFor(async () => {
        const current = await reader.api.task(accepted.taskId);
        return current.state === 'completed' ? current : null;
      });

      const full = await replayEvents(reader, accepted.taskId, { after: 0 });
      assert.ok(full.events.length >= 3);
      assert.equal(full.truncated, false);

      // The log a third replica composes runs the same prune the bus applies
      // after a terminal flush: retention belongs to the store, not to the
      // process that wrote it.
      database = await openLiveDatabase();
      const log = createMongoEventLog({
        events: database.collection(`${prefix}events`),
        heads: database.collection(`${prefix}event_heads`),
      });
      const removed = await log.prune(accepted.taskId, 2);
      assert.ok(removed > 0, 'retention removed the older events');
      assert.equal(
        await log.lastSeq(accepted.taskId),
        full.lastSeq,
        'retention does not move the durable watermark',
      );

      const retained = full.events.slice(-2);
      const truncated = await replayEvents(reader, accepted.taskId, { after: 0 });
      assert.equal(truncated.truncated, true, 'a cursor below the retained window is a gap');
      assert.deepEqual(
        truncated.events.map((event) => event.eventId),
        retained.map((event) => event.eventId),
      );
      assert.equal(truncated.lastSeq, full.lastSeq);
      assert.equal(truncated.events[0]?.seq, retained[0]?.seq);
      assert.ok(
        truncated.events[0]!.seq > 1,
        'the retained window starts after the dropped events',
      );

      const edge = await replayEvents(reader, accepted.taskId, {
        after: retained[0]!.seq - 1,
      });
      assert.equal(edge.truncated, false, 'a cursor at the retained edge is not a gap');
      assert.deepEqual(
        edge.events.map((event) => event.eventId),
        retained.map((event) => event.eventId),
      );

      const deep = await replayEvents(reader, accepted.taskId, { after: 1 });
      assert.equal(deep.truncated, true);
      assert.deepEqual(
        deep.events.map((event) => event.eventId),
        retained.map((event) => event.eventId),
      );
    } finally {
      await writer.close();
      await reader.close();
      await database?.close();
      await dropPrefix(prefix);
    }
  },
);

test(
  'a real resume on another replica owns generation 2 and fences the superseded run',
  { skip },
  async () => {
    const prefix = uniquePrefix();
    let releaseAdapter: () => void = () => undefined;
    const adapterLatch = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    // Holds the owner inside its adapter until the test lets it go, and exposes
    // the signal so the abort can be observed rather than guessed at.
    let adapterSignal: AbortSignal | undefined;
    const gateway: ModelGateway = {
      id: 'latched-test-gateway',
      complete: async ({ signal }: { signal: AbortSignal }) => {
        adapterSignal = signal;
        await adapterLatch;
        if (signal.aborted) throw new Error('aborted');
        return { text: 'A late result.', usage: { inputTokens: 5, outputTokens: 7 } };
      },
    };
    const owner = await startReplica(prefix, { gateway });
    const next = await startReplica(prefix);
    let database: MongoDatabase | null = null;
    try {
      const accepted = await owner.api.submitWork({
        objective: 'A stream that outlives the generation that started it',
        mode: 'cloud',
        agent: 'coderax',
        requireApproval: true,
      });
      await waitFor(async () => {
        const current = await next.api.task(accepted.taskId);
        return current.state === 'running' ? current : null;
      });

      // Read the prefix from the replica that wrote it, so the resuming replica
      // has never touched this stream: that is the state a restarted or freshly
      // scaled replica is in when it takes over someone else's run.
      const owned = await owner.service.events(OWNER, accepted.taskId, 0);
      assert.ok(owned.ok);
      assert.deepEqual(
        owned.value.replay.events.slice(0, 2).map((event) => event.type),
        ['task.queued', 'task.started'],
        'the accepted and started events are durable while the adapter is blocked',
      );
      assert.ok(
        owned.value.replay.events.every(
          (event) =>
            !['task.completed', 'task.failed', 'task.cancelled', 'task.interrupted'].includes(
              event.type,
            ),
        ),
        'nothing in the mid-run prefix settles the task',
      );
      const watermark = owned.value.lastSeq;
      assert.ok(watermark >= 2);

      // The owner stopped heartbeating: from this replica's clock the lease is
      // gone, so the run is safe to resume. Generation 2 is created by the
      // production control path, never by publishing on its behalf.
      next.app.dependencies.clock.now = () => new Date(Date.now() + 60_000);
      const resumed = await next.api.resume(accepted.taskId, 1);
      assert.equal(resumed.outcome, 'accepted');
      assert.equal(resumed.generation, 2);

      const completed = await waitFor(async () => {
        const current = await next.api.task(accepted.taskId);
        return current.state === 'completed' ? current : null;
      });
      assert.equal(completed.generation, 2);
      // The terminal record is visible before settlement finishes its transcript,
      // notification and lease writes; wait for the run to let go of the store
      // before anything closes its client.
      await next.app.dependencies.scheduler.idle();
      // Losing the shared lease aborts the superseded run, so its adapter is
      // cancelled instead of reporting into a generation it no longer owns.
      await waitFor(async () => (adapterSignal?.aborted ? true : null));
      releaseAdapter();
      await owner.app.dependencies.scheduler.idle();

      const full = await replayEvents(next, accepted.taskId, { after: 0 });
      assert.equal(full.events.at(-1)?.type, 'task.completed');
      const first = full.events.filter((event) => event.generation === 1);
      const second = full.events.filter((event) => event.generation === 2);
      assert.deepEqual(
        first.slice(0, 2).map((event) => event.type),
        ['task.queued', 'task.started'],
        'generation 1 keeps the prefix it wrote',
      );
      assert.equal(
        first.at(-1)?.type,
        'task.interrupted',
        'the recovery records why generation 1 stopped before generation 2 begins',
      );
      assert.equal(first.at(-1)?.seq, watermark + 1);
      assert.deepEqual(
        second.slice(0, 2).map((event) => event.type),
        ['task.queued', 'text.replace'],
        'the resumed generation continues the shared stream instead of restarting it',
      );
      assert.equal(second[0]?.seq, watermark + 2, 'the resume starts after the durable watermark');
      assert.equal(second[1]?.seq, watermark + 3);
      assert.ok(
        full.events.every(
          (event, index) => index === 0 || event.seq > full.events[index - 1]!.seq,
        ),
        'one strictly increasing sequence spans both generations',
      );
      assert.equal(
        full.events.length,
        first.length + second.length,
        'no event was lost or stored twice',
      );
      assert.equal(full.lastSeq, second.at(-1)?.seq);

      // The owner still holds generation 1 and never saw the resume. The shared
      // head row is what refuses it, not any state local to this process.
      assert.equal(owner.app.dependencies.events.lastSeq(accepted.taskId), watermark);
      const stale = owner.app.dependencies.events.publish({
        taskId: accepted.taskId,
        agent: 'coderax',
        generation: 1,
        type: 'text.delta',
        payload: { text: 'late from a superseded generation' },
      });
      assert.equal(stale.seq, watermark + 1);
      await owner.app.dependencies.events.flush(accepted.taskId);

      // The refusal seals the bus, so the next event is never even attempted.
      owner.app.dependencies.events.publish({
        taskId: accepted.taskId,
        agent: 'coderax',
        generation: 1,
        type: 'task.completed',
        payload: { summary: 'late settlement' },
      });
      await owner.app.dependencies.events.flush(accepted.taskId);

      database = await openLiveDatabase();
      const stored = await database
        .collection(`${prefix}events`)
        .find({ taskId: accepted.taskId })
        .sort({ seq: 1 })
        .toArray();
      assert.deepEqual(
        stored.map((document) => document.seq),
        full.events.map((event) => event.seq),
        'the refused events were never stored',
      );
      assert.deepEqual(
        stored.map((document) => document.generation),
        [...first.map(() => 1), ...second.map(() => 2)],
        'generation 2 is the only writer after the watermark',
      );
      assert.ok(
        stored.every((document) => !JSON.stringify(document).includes('superseded')),
        'the stale payload is absent from the durable stream',
      );

      const head = await database
        .collection(`${prefix}event_heads`)
        .findOne({ taskId: accepted.taskId });
      assert.equal(head?.generation, 2, 'the shared head is monotonic');

      // A third replica composing its own log is refused by the same head.
      const probe = createMongoEventLog({
        events: database.collection(`${prefix}events`),
        heads: database.collection(`${prefix}event_heads`),
      });
      const refused = await probe.append([
        { ...full.events[0]!, eventId: 'stale-probe', seq: full.lastSeq + 9, generation: 1 },
      ]);
      assert.deepEqual(refused, ['stale_generation']);
      assert.equal(await probe.lastSeq(accepted.taskId), full.lastSeq);
    } finally {
      // Let the superseded adapter return before the owner is shut down, so a
      // failing assertion cannot leave a run in flight.
      releaseAdapter();
      await owner.app.dependencies.scheduler.idle().catch(() => undefined);
      await owner.close();
      await next.close();
      await database?.close();
      await dropPrefix(prefix);
    }
  },
);
