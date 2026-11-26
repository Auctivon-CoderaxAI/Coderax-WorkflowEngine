import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  DocumentRequest,
  PresentationRequest,
  SoftwareRequest,
  SpreadsheetRequest,
  type ArtifactDescriptor,
} from '@coderax/contracts';
import { createArtifactGenerator, type GenerationResult } from '../../src/artifacts/generate.js';
import type { Principal } from '../../src/security/auth.js';
import type { ServiceResult } from '../../src/support/result.js';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import type { ArtifactService } from '../../src/artifacts/service.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import { baseConfig, createWorkspaces, fakeGateway, OWNER_ID, OWNER_TOKEN } from '../helpers.js';
import {
  REAL_MONGO_SKIP,
  requireRealMongo,
  startRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';

/**
 * The generator path end to end: real renderers produce bytes, the durable tree
 * adapter stores them, a second generation edits by immutable version, and a
 * restore points each artifact back at the first version. This uses a real
 * MongoDB deployment, not the repository fake.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

const skip = maybeMongo === null ? REAL_MONGO_SKIP : false;
const PRINCIPAL: Principal = { ownerId: OWNER_ID, isOwner: true };

after(async () => {
  await maybeMongo?.stop();
});

function resultOf<T>(value: ServiceResult<T>): T {
  if (!value.ok) throw new Error(`${value.code}: ${value.detail}`);
  return value.value;
}

function find(result: GenerationResult, relativePath: string) {
  const file = result.files.find((entry) => entry.relativePath === relativePath);
  assert.ok(file, relativePath);
  return file;
}


async function download(
  service: ArtifactService,
  artifact: Pick<ArtifactDescriptor, 'artifactId'>,
  version?: number,
): Promise<Buffer> {
  const downloaded = resultOf(
    await service.download(
      PRINCIPAL,
      artifact.artifactId,
      { mode: 'cloud', ...(version !== undefined ? { version } : {}) },
    ),
  );
  return Buffer.from(downloaded.contentBase64, 'base64');
}

test(
  'generated DOCX, PDF, XLSX, PPTX and a software tree download, edit and restore durably',
  { skip },
  async () => {
    const real = maybeMongo as RealMongo;
    const databaseName = `coderax_generate_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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
      await app.start();
      const service = app.dependencies.artifactService;
      const generator = createArtifactGenerator({ artifacts: service });
      const principal = PRINCIPAL;
      const projectId = 'proj_generated_e2e';
      const mode = 'cloud' as const;

      const firstDocument = DocumentRequest.parse({
        kind: 'document',
        mode,
        filename: 'quarterly-report',
        title: 'Quarterly report',
        blocks: [
          { type: 'heading', level: 1, text: 'Quarterly report' },
          { type: 'paragraph', text: 'Revenue grew in every region.' },
          {
            type: 'table',
            headers: ['Metric', 'Value'],
            rows: [['Revenue', '100']],
          },
        ],
        formats: ['docx', 'pdf', 'markdown'],
      });
      const firstSpreadsheet = SpreadsheetRequest.parse({
        kind: 'spreadsheet',
        mode,
        filename: 'budget',
        title: 'Annual budget',
        sheets: [
          {
            name: 'Budget',
            columns: [
              { header: 'Item', type: 'text' },
              { header: 'Amount', type: 'currency', total: true },
            ],
            rows: [
              ['Hosting', 10],
              ['Models', 20],
            ],
            formulas: [],
            charts: [],
            table: true,
            freezeHeader: true,
          },
        ],
      });
      const firstPresentation = PresentationRequest.parse({
        kind: 'presentation',
        mode,
        filename: 'launch',
        title: 'Launch plan',
        slides: [
          { layout: 'title', title: 'Launch plan', subtitle: 'Quarterly review' },
          { layout: 'content', title: 'Goals', bullets: ['Ship the durable store'] },
        ],
      });
      const firstSoftware = SoftwareRequest.parse({
        kind: 'software',
        mode,
        name: 'sample-module',
        description: 'A generated module',
        template: 'module',
        language: 'javascript',
        files: [],
      });

      const documentOne = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: firstDocument,
        }),
      );
      const spreadsheetOne = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: firstSpreadsheet,
        }),
      );
      const presentationOne = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: firstPresentation,
        }),
      );
      const softwareOne = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: firstSoftware,
        }),
      );

      const documentDocx = find(documentOne, 'documents/quarterly-report.docx');
      const documentPdf = find(documentOne, 'documents/quarterly-report.pdf');
      const workbook = find(spreadsheetOne, 'workbooks/budget.xlsx');
      const deck = find(presentationOne, 'decks/launch.pptx');
      const softwareSource = find(softwareOne, 'src/index.js');

      const firstBytes = new Map<string, Buffer>();
      for (const [label, file] of [
        ['docx', documentDocx],
        ['pdf', documentPdf],
        ['xlsx', workbook],
        ['pptx', deck],
        ['source', softwareSource],
      ] as const) {
        firstBytes.set(label, await download(service, file, 1));
      }
      assert.equal(firstBytes.get('docx')?.subarray(0, 2).toString('latin1'), 'PK');
      assert.equal(firstBytes.get('pdf')?.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.equal(firstBytes.get('xlsx')?.subarray(0, 2).toString('latin1'), 'PK');
      assert.equal(firstBytes.get('pptx')?.subarray(0, 2).toString('latin1'), 'PK');
      assert.match(firstBytes.get('source')?.toString('utf8') ?? '', /export function run/);

      const secondDocument = DocumentRequest.parse({
        ...firstDocument,
        edits: [
          { op: 'setTitle', title: 'Quarterly report (revised)' },
          {
            op: 'replace',
            index: 1,
            block: { type: 'paragraph', text: 'Revenue grew in every region and margins improved.' },
          },
          {
            op: 'replace',
            index: 2,
            block: {
              type: 'table',
              headers: ['Metric', 'Value'],
              rows: [['Revenue', '125']],
            },
          },
        ],
      });
      const secondSpreadsheet = SpreadsheetRequest.parse({
        ...firstSpreadsheet,
        title: 'Annual budget (revised)',
        sheets: [
          {
            ...firstSpreadsheet.sheets[0]!,
            rows: [
              ['Hosting', 10],
              ['Models', 25],
              ['Storage', 5],
            ],
          },
        ],
      });
      const secondPresentation = PresentationRequest.parse({
        ...firstPresentation,
        title: 'Launch plan (revised)',
        slides: [
          { layout: 'title', title: 'Launch plan (revised)', subtitle: 'Quarterly review' },
          { layout: 'content', title: 'Goals', bullets: ['Ship the durable store', 'Add restore'] },
        ],
      });
      const secondSoftware = SoftwareRequest.parse({
        ...firstSoftware,
        description: 'A generated module with durable versions',
      });

      const documentTwo = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: secondDocument,
        }),
      );
      const spreadsheetTwo = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: secondSpreadsheet,
        }),
      );
      const presentationTwo = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: secondPresentation,
        }),
      );
      const softwareTwo = resultOf(
        await generator.generate(principal, {
          projectId,
          mode,
          request: secondSoftware,
        }),
      );

      const versions = [
        { path: 'documents/quarterly-report.docx', first: documentOne, second: documentTwo },
        { path: 'documents/quarterly-report.pdf', first: documentOne, second: documentTwo },
        { path: 'workbooks/budget.xlsx', first: spreadsheetOne, second: spreadsheetTwo },
        { path: 'decks/launch.pptx', first: presentationOne, second: presentationTwo },
        { path: 'src/index.js', first: softwareOne, second: softwareTwo },
      ];
      for (const entry of versions) {
        assert.equal(find(entry.first, entry.path).version, 1, entry.path);
        assert.equal(find(entry.second, entry.path).version, 2, entry.path);
      }

      const revised = await download(service, find(documentTwo, 'documents/quarterly-report.docx'), 2);
      assert.notEqual(revised.toString('base64'), firstBytes.get('docx')?.toString('base64'));

      for (const { path, label, second } of [
        { path: 'documents/quarterly-report.docx', label: 'docx', second: documentTwo },
        { path: 'documents/quarterly-report.pdf', label: 'pdf', second: documentTwo },
        { path: 'workbooks/budget.xlsx', label: 'xlsx', second: spreadsheetTwo },
        { path: 'decks/launch.pptx', label: 'pptx', second: presentationTwo },
        { path: 'src/index.js', label: 'source', second: softwareTwo },
      ] as const) {
        const current = find(second, path);
        const restored = resultOf(
          await service.restore(principal, current.artifactId, {
            mode,
            version: 1,
            expectedVersion: 2,
          }),
        );
        assert.equal(restored.version.version, 1);
        assert.deepEqual(await download(service, current), firstBytes.get(label));
      }
    } finally {
      await app?.stop().catch(() => undefined);
      await database.close().catch(() => undefined);
    }
  },
);
