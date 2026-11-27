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
        'createModelRouter({});',
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
        'export function createModelRouter() {}',
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

test('two competing model router implementations are rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/models/router.ts', 'export function createRouter() {}\n'),
    file('src/models/router-v2.ts', 'export function createModelRouter() {}\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'duplicate_model_router'));
});

test('a provider call outside the gateway is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/agents/rogue.ts', "export async function call() { await fetch('https://example.test'); }\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'unauthorized_inference'));
});

test('a model provider adapter is allowed to reach its provider endpoint', () => {
  const files = [
    ...baseRepository(),
    file('src/models/providers/http.ts', "export async function call() { await fetch('https://provider.test'); }\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(!findings.some((finding) => finding.rule === 'unauthorized_inference'));
});

test('explicit tool and MCP transports are allowed network seams', () => {
  const files = [
    ...baseRepository(),
    file('src/tools/builtin.ts', "export async function call() { await fetch('https://tool.test'); }\n"),
    file('src/mcp/client.ts', "export async function call() { await fetch('https://mcp.test'); }\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(!findings.some((finding) => finding.rule === 'unauthorized_inference'));
});

test('an alternate HTTP client is rejected outside the provider/tool seams', () => {
  const files = [
    ...baseRepository(),
    file('src/agents/native/planner.ts', "import axios from 'axios';\nexport const call = () => axios.get('https://provider.test');\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'unauthorized_http_client'));
});

test('a provider SDK is rejected outside the provider adapter seam', () => {
  const files = [
    ...baseRepository(),
    file('src/agents/rogue.ts', "import OpenAI from 'openai';\nexport const client = new OpenAI();\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'unauthorized_provider_sdk'));
});

test('a subprocess outside the explicit tool seams is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/execution/rogue.ts', "import { spawn } from 'node:child_process';\nspawn('sh', []);\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'unauthorized_subprocess'));
});

test('the inbound API server may import node:http without being an inference path', () => {
  const files = [
    ...baseRepository(),
    file('src/api/server.ts', "import { createServer } from 'node:http';\nexport const server = createServer;\n"),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(!findings.some((finding) => finding.rule === 'unauthorized_http_client'));
});

test('a dynamically imported alternative composition root is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/main.ts', "import('./bootstrap/alt.js');\n"),
    file('src/bootstrap/alt.ts', 'export const boot = true;\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'single_construction_root'));
});

test('a factory alias outside the composition root is rejected', () => {
  const files = [
    ...baseRepository(),
    file('src/api/alt.ts', 'const bootstrap = createTaskRunner;\nexport const ready = bootstrap;\n'),
  ];
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some((finding) => finding.rule === 'single_construction_root'));
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

test('dependency rules see same-line imports and ignore dynamic imports in comments', () => {
  const files = [
    ...baseRepository(),
    file('src/agents/extra.ts', "import 'zod'; import type { ApplicationService } from '../orchestration/service.js';"),
    file('src/api/extra.ts', "import '../persistence/store.js'; // import('./retired.js')"),
    file('src/persistence/store.ts', ''),
    file('src/execution/extra.ts', "import '../orchestration/service.js'; import('./missing.js');"),
  ].map((entry) => entry.path === 'src/orchestration/service.ts'
    ? { ...entry, text: "import '../execution/extra.js';\n" + entry.text }
    : entry);
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some(({ rule }) => rule === 'boundary_agents'));
  assert.ok(findings.some(({ rule }) => rule === 'boundary_api'));
  assert.deepEqual(findings.filter(({ rule }) => rule === 'boundary_lower_layers').map(({ path }) => path), [
    'src/execution/extra.ts',
  ]);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'unresolved_dynamic_import').map(({ path }) => path), [
    'src/execution/extra.ts',
  ]);
});

test('singleton construction limits apply inside the composition root only to factories', () => {
  const files = baseRepository().map((entry) => {
    if (entry.path === 'src/bootstrap/compose.ts') return { ...entry, text: entry.text + '\ncreateTaskRunner /* another instance */ ({});' };
    if (entry.path === 'src/orchestration/service.ts') return { ...entry, text: entry.text + '\ntasks.updateFenced({});' };
    return entry;
  });
  const findings = checkArchitecture({ files, entry: 'src/main.ts' });
  assert.ok(findings.some(({ rule, path }) => rule === 'single_task_runner' && path === 'src/bootstrap/compose.ts'));
  assert.ok(!findings.some(({ rule }) => rule === 'single_terminal_writer'));
});

test('namespace and renamed imports count toward the same singleton limit', () => {
  const check = (calls: string) => checkArchitecture({
    entry: 'src/main.ts',
    files: baseRepository().map((entry) => entry.path === 'src/bootstrap/compose.ts'
      ? {
          ...entry,
          text: [
            "import * as factories from './factories.js';",
            "import { createTaskRunner as makeRunner } from './factories.js';",
            entry.text.replace('createTaskRunner({});', calls),
          ].join('\n').replace("import { factories } from './factories.js';\nfactories();", ''),
        }
      : entry),
  }).filter(({ rule }) => rule === 'single_task_runner');

  assert.deepEqual(check('factories.createTaskRunner({});'), []);
  assert.deepEqual(check('makeRunner({});'), []);
  assert.deepEqual(check('makeRunner({}); function example(factories: any) { factories.createTaskRunner({}); }'), []);
  for (const calls of [
    'factories.createTaskRunner({}); factories.createTaskRunner({});',
    'makeRunner({}); makeRunner({});',
    'makeRunner({}); factories.createTaskRunner({});',
  ]) {
    assert.deepEqual(check(calls).map(({ path }) => path), ['src/bootstrap/compose.ts']);
  }
});
