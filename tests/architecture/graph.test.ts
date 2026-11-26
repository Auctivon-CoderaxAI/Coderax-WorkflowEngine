import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkArchitecture,
  formatFinding,
  loadRepository,
  parseImports,
  unreachableModules,
  type SourceFile,
} from '../../scripts/architecture.js';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

function file(pathName: string, text: string): SourceFile {
  return { path: pathName, text };
}

function baseRepository(): SourceFile[] {
  return [
    file('src/main.ts', "import { compose } from './bootstrap/compose.js';\ncompose();\n"),
    file(
      'src/bootstrap/compose.ts',
      [
        "import { createApplicationService } from '../orchestration/service.js';",
        "import { factories } from './factories.js';",
        'factories();',
        'createApplicationService({});',
        'createTaskRunner({});',
        'createModelCatalog({});',
        'createEventBus({});',
        'createRouteRegistry();',
        'createHttpServer({});',
        'createTaskScheduler({});',
      ].join('\n'),
    ),
    file(
      'src/bootstrap/factories.ts',
      [
        'export function createApplicationService() {}',
        'export function createTaskRunner() {}',
        'export function createModelCatalog() {}',
        'export function createEventBus() {}',
      ].join('\n'),
    ),
    file(
      'src/orchestration/service.ts',
      [
        'scheduler.enqueue(() => undefined);',
        'runner.run({});',
        'lease.claim({});',
        'tasks.updateFenced({});',
      ].join('\n'),
    ),
    file('packages/contracts/src/routes.ts', "export const ROUTES = [];\nconst route = { operationId: 'x' };\n"),
    file('packages/contracts/src/openapi.ts', 'export function build() { return buildOpenApiDocument(); }\n'),
    file('packages/sdk/src/index.ts', "import { ROUTES } from '@coderax/contracts';\nexport const SDK = ROUTES;\n"),
    file('scripts/openapi.ts', 'export const render = () => buildOpenApiDocument();\n'),
  ];
}

test('the checked-in repository has one owner per capability and no boundary violations', () => {
  const findings = checkArchitecture(loadRepository(root));
  assert.deepEqual(findings.map(formatFinding), []);
});

test('module reachability follows relative and type-only imports', () => {
  const files = [
    file('src/main.ts', "import type { Shape } from './types.js';\n"),
    file('src/types.ts', "export type Shape = { value: string };\n"),
    file('src/orphan.ts', 'export const orphan = true;\n'),
  ];
  assert.deepEqual(unreachableModules(files, 'src/main.ts'), ['src/orphan.ts']);
});

test('parseImports sees static, side-effect and dynamic imports', () => {
  const refs = parseImports(
    [
      "import { a } from './a.js';",
      "import type { B } from './b.js';",
      "export { c } from './c.js';",
      "import './side-effect.js';",
      "const lazy = import('./lazy.js');",
    ].join('\n'),
  );
  assert.deepEqual(
    refs.map((ref) => [ref.specifier, ref.typeOnly]),
    [
      ['./a.js', false],
      ['./b.js', true],
      ['./c.js', false],
      ['./side-effect.js', false],
      ['./lazy.js', false],
    ],
  );
});

test('a second task runner construction is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/api/routes.ts', 'createTaskRunner({});\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(
    findings.some((finding) => finding.rule === 'single_task_runner' && finding.path === 'src/api/routes.ts'),
    JSON.stringify(findings),
  );
});

test('a second HTTP server construction is rejected', () => {
  const files = [...baseRepository(), file('src/api/extra.ts', 'createHttpServer({});\n')];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'single_http_server'));
});

test('a competing workflow-engine declaration is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/legacy/engine.ts', 'export function createApplicationService() {}\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'duplicate_workflow_engine'));
});

test('a duplicated model catalogue declaration is rejected', () => {
  const files = [...baseRepository(), file('src/models/second.ts', 'export function createModelCatalog() {}\n')];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'duplicate_model_catalog'));
});

test('two competing model router implementations are rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/models/router.ts', 'export function createRouter() {}\n'),
    file('src/models/router-v2.ts', 'export function createModelRouter() {}\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'duplicate_model_router'));
});

test('an orphaned capability module is rejected', () => {
  const files = [...baseRepository(), file('src/execution/dead.ts', 'export const dead = true;\n')];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'disconnected_module'));
});

test('an exported factory with no consumer is rejected', () => {
  const files = [...baseRepository(), file('src/tools/unwired.ts', 'export function createUnwiredTool() {}\n')];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'unused_factory'));
});

test('agents may not import persistence or orchestration', () => {
  const files = [
    ...baseRepository(),
    file('src/agents/bad.ts', "import { tasks } from '../persistence/tasks.js';\n"),
    file('src/persistence/tasks.ts', 'export const tasks = {};\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'boundary_agents'));
});

test('the SDK may not import engine internals', () => {
  const files = [
    ...baseRepository(),
    file('packages/sdk/src/bad.ts', "import '../../../src/bootstrap/compose.js';\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'boundary_sdk'));
});

test('the route catalogue has a single declaration site', () => {
  const files = [...baseRepository(), file('src/api/routes.ts', "export const ROUTES = [];\n")];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'duplicate_route_catalogue'));
});
