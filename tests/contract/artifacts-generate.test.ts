import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  DurableDocumentRequest,
  ROUTE_INDEX,
  type ArtifactManifestEntry,
} from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import { baseConfig, createWorkspaces, fakeGateway, OWNER_TOKEN } from '../helpers.js';
import {
  REAL_MONGO_SKIP,
  requireRealMongo,
  startRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';

/**
 * The generation operation as a client sees it: the published catalogue, the
 * SDK's request and response schemas, and the real HTTP server. Persistence is
 * a real MongoDB, so the manifest, version and restore assertions describe the
 * durable store rather than an in-process fake.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

const skip = maybeMongo === null ? REAL_MONGO_SKIP : false;

after(async () => {
  await maybeMongo?.stop();
});

function find(entries: ArtifactManifestEntry[], relativePath: string): ArtifactManifestEntry {
  const entry = entries.find((candidate) => candidate.relativePath === relativePath);
  assert.ok(entry, relativePath);
  return entry;
}

test(
  'the contract and SDK expose durable generation with version and restore semantics',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const databaseName = `coderax_generate_contract_${Date.now()}_${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    const database = await createMongoConnector()({ uri: real.uri, database: databaseName });
    let app: Application | undefined;

    try {
      app = await composeApplication({
        config: baseConfig(createWorkspaces(), {
          persistence: { driver: 'mongo', database: databaseName },
        }),
        env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
        gateway: fakeGateway(),
        persistence: { database },
      });
      const { url } = await app.start();
      const client = new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
      const projectId = 'proj_contract_generate';
      const mode = 'cloud' as const;

      const route = ROUTE_INDEX.get('generateArtifact');
      assert.equal(route?.method, 'POST');
      assert.equal(route?.path, '/v1/artifacts/generate');
      assert.equal(route?.response.status, 201);

      const deliverable = DurableDocumentRequest.parse({
        kind: 'document',
        mode,
        filename: 'contract-report',
        title: 'Contract report',
        blocks: [
          { type: 'heading', level: 1, text: 'Contract report' },
          { type: 'paragraph', text: 'The API persists real bytes.' },
        ],
        formats: ['docx', 'pdf', 'markdown'],
      });

      const first = await client.generateArtifact({ projectId, deliverable });
      assert.equal(first.projectId, projectId);
      assert.equal(first.kind, 'document');
      assert.equal(first.title, 'Contract report');
      assert.equal(first.manifest.mode, mode);
      assert.equal(first.checks.length > 0, true);
      assert.equal(first.checks.every((check) => check.ok), true);

      const docxOne = find(first.manifest.files, 'documents/contract-report.docx');
      const pdfOne = find(first.manifest.files, 'documents/contract-report.pdf');
      assert.equal(docxOne.version, 1);
      assert.equal(pdfOne.version, 1);
      assert.equal(find(first.manifest.files, 'documents/contract-report.md').version, 1);

      // The generation response is the persisted manifest, not a projection.
      const manifest = await client.artifactManifest(projectId, mode);
      assert.equal(manifest.digest, first.manifest.digest);

      const docxV1 = Buffer.from(
        (await client.downloadArtifact(docxOne.artifactId, { mode })).contentBase64,
        'base64',
      );
      const pdfV1 = Buffer.from(
        (await client.downloadArtifact(pdfOne.artifactId, { mode })).contentBase64,
        'base64',
      );
      assert.equal(docxV1.subarray(0, 2).toString('latin1'), 'PK');
      assert.equal(pdfV1.subarray(0, 5).toString('latin1'), '%PDF-');

      const revised = DurableDocumentRequest.parse({
        ...deliverable,
        edits: [
          { op: 'setTitle', title: 'Contract report (revised)' },
          {
            op: 'replace',
            index: 1,
            block: {
              type: 'paragraph',
              text: 'The API persists real bytes and immutable versions.',
            },
          },
        ],
      });
      const second = await client.generateArtifact({ projectId, deliverable: revised });
      const docxTwo = find(second.manifest.files, 'documents/contract-report.docx');
      assert.equal(docxTwo.artifactId, docxOne.artifactId);
      assert.equal(docxTwo.version, 2);
      assert.notEqual(docxTwo.sha256, docxOne.sha256);

      const history = await client.artifactVersions(docxOne.artifactId, mode);
      assert.deepEqual(
        history.versions.map((entry) => entry.version),
        [1, 2],
      );

      await client.restoreArtifactVersion(docxOne.artifactId, {
        mode,
        version: 1,
        expectedVersion: 2,
      });
      const restored = Buffer.from(
        (await client.downloadArtifact(docxOne.artifactId, { mode })).contentBase64,
        'base64',
      );
      assert.deepEqual(restored, docxV1);

      // HTML is not a durable media type, so the contract does not advertise it
      // for generation even though the workspace producer can render it.
      await assert.rejects(
        () =>
          client.generateArtifact({
            projectId,
            deliverable: {
              kind: 'document',
              mode,
              filename: 'not-durable',
              title: 'Not durable',
              blocks: [],
              formats: ['html'],
            } as never,
          }),
        (error: unknown) =>
          error instanceof CoderaxApiError &&
          error.status === 400 &&
          error.code === 'validation_failed',
      );

      // Dataset and media deliverables produce no project tree, so the contract
      // refuses them before a renderer is selected.
      await assert.rejects(
        () =>
          client.generateArtifact({
            projectId,
            deliverable: {
              kind: 'dataset',
              mode,
              filename: 'not-durable',
              source: { format: 'csv', text: 'a,b\n1,2' },
              steps: [],
              charts: [],
              exports: ['xlsx'],
            } as never,
          }),
        (error: unknown) =>
          error instanceof CoderaxApiError &&
          error.status === 400 &&
          error.code === 'validation_failed',
      );
    } finally {
      await app?.stop().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  },
);
