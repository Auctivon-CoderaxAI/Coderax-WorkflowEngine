import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Static architecture enforcement.
 *
 * These checks answer questions a compiler cannot: is every module wired into
 * the composition root, does any module construct a second owner for a
 * capability, and does a dependency edge cross a stated boundary. The functions
 * are pure over a file list so the gate itself can be tested with deliberately
 * broken fixtures; a gate that cannot fail is not a gate.
 */

export type SourceFile = { path: string; text: string };
export type Finding = { rule: string; path: string; detail: string };
export type ImportRef = { specifier: string; typeOnly: boolean };
export type Edge = { from: string; to: string; typeOnly: boolean };

export type Repository = {
  files: SourceFile[];
  entry: string;
};

export function parseImports(text: string): ImportRef[] {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLineComments = withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
  const refs: ImportRef[] = [];
  const staticImport =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of withoutLineComments.matchAll(staticImport)) {
    if (match[2]) refs.push({ specifier: match[2], typeOnly: match[1] !== undefined });
  }
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of withoutLineComments.matchAll(dynamicImport)) {
    if (match[1]) refs.push({ specifier: match[1], typeOnly: false });
  }
  return refs;
}

/** Resolve a relative `.js` import to the `.ts` file that produced it. */
export function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (joined.endsWith('.js')) return `${joined.slice(0, -3)}.ts`;
  if (joined.endsWith('.ts')) return joined;
  return `${joined}.ts`;
}

export function buildEdges(files: SourceFile[]): Edge[] {
  const known = new Set(files.map((file) => file.path));
  const edges: Edge[] = [];
  for (const file of files) {
    for (const ref of parseImports(file.text)) {
      const target = resolveRelative(file.path, ref.specifier);
      if (target && known.has(target)) {
        edges.push({ from: file.path, to: target, typeOnly: ref.typeOnly });
      }
    }
  }
  return edges;
}

export function unreachableModules(files: SourceFile[], entry: string): string[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  if (!byPath.has(entry)) return [entry];
  const edges = buildEdges(files);
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...byPath.keys()].filter((file) => !seen.has(file)).sort();
}

const BOUNDARIES: ReadonlyArray<{
  rule: string;
  from: RegExp;
  to: RegExp;
  detail: string;
}> = [
  {
    rule: 'boundary_agents',
    from: /^src\/agents\//,
    to: /^src\/(orchestration|api|persistence)\//,
    detail: 'agents may not import orchestration, api or persistence',
  },
  {
    rule: 'boundary_models',
    from: /^src\/models\//,
    to: /^src\/(agents|execution|orchestration|api|persistence)\//,
    detail: 'models may not import a caller, an executor or storage',
  },
  {
    rule: 'boundary_contracts',
    from: /^packages\/contracts\//,
    to: /^(src|packages\/sdk)\//,
    detail: 'contracts must not depend on the engine or the SDK',
  },
  {
    rule: 'boundary_sdk',
    from: /^packages\/sdk\//,
    to: /^(src|packages\/contracts\/)/,
    detail: 'the SDK may import @coderax/contracts, never engine internals',
  },
];

const CONSTRUCTIONS: ReadonlyArray<{
  rule: string;
  token: string;
  allowed: string[];
  minimum?: number;
}> = [
  { rule: 'single_workflow_engine', token: 'createApplicationService({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_task_runner', token: 'createTaskRunner({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_model_router', token: 'createModelCatalog({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_event_bus', token: 'createEventBus({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_route_registry', token: 'createRouteRegistry();', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_http_server', token: 'createHttpServer({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_scheduler', token: 'createTaskScheduler({', allowed: ['src/bootstrap/compose.ts'] },
  { rule: 'single_run_dispatch', token: 'scheduler.enqueue(', allowed: ['src/orchestration/service.ts'] },
  { rule: 'single_run_ownership', token: 'runner.run(', allowed: ['src/orchestration/service.ts'] },
  { rule: 'single_lease_claim', token: 'lease.claim(', allowed: ['src/orchestration/service.ts'] },
  { rule: 'single_terminal_writer', token: 'tasks.updateFenced(', allowed: ['src/orchestration/service.ts'] },
  {
    rule: 'single_route_catalogue',
    token: "operationId: '",
    allowed: ['packages/contracts/src/routes.ts'],
    minimum: 1,
  },
  {
    rule: 'single_openapi_builder',
    token: 'buildOpenApiDocument(',
    allowed: ['packages/contracts/src/openapi.ts', 'src/api/router.ts', 'scripts/openapi.ts'],
    minimum: 1,
  },
];

const UNIQUE_DECLARATIONS: ReadonlyArray<{ rule: string; token: string }> = [
  { rule: 'duplicate_workflow_engine', token: 'export function createApplicationService(' },
  { rule: 'duplicate_task_runner', token: 'export function createTaskRunner(' },
  { rule: 'duplicate_model_catalog', token: 'export function createModelCatalog(' },
  { rule: 'duplicate_event_bus', token: 'export function createEventBus(' },
  { rule: 'duplicate_route_catalogue', token: 'export const ROUTES' },
];

function occurrenceCount(files: SourceFile[], token: string): number {
  return files.reduce(
    (total, file) => total + (file.text.split(token).length - 1),
    0,
  );
}

function factoryExports(file: SourceFile): string[] {
  return [...file.text.matchAll(/export\s+(?:async\s+)?function\s+(create[A-Za-z0-9_]+)/g)].map(
    (match) => match[1] as string,
  );
}

export function checkArchitecture(repository: Repository): Finding[] {
  const findings: Finding[] = [];
  const { files, entry } = repository;

  const engineFiles = files.filter((file) => file.path.startsWith('src/'));
  for (const file of unreachableModules(engineFiles, entry)) {
    findings.push({
      rule: 'disconnected_module',
      path: file,
      detail: `module is not reachable from ${entry}; wire it into the composition root or delete it`,
    });
  }

  for (const edge of buildEdges(files)) {
    for (const boundary of BOUNDARIES) {
      if (boundary.from.test(edge.from) && boundary.to.test(edge.to)) {
        findings.push({
          rule: boundary.rule,
          path: edge.from,
          detail: `${boundary.detail} (imports ${edge.to})`,
        });
      }
    }
  }

  for (const construction of CONSTRUCTIONS) {
    let count = 0;
    for (const file of files) {
      const occurrences = file.text.split(construction.token).length - 1;
      if (occurrences === 0) continue;
      count += occurrences;
      if (!construction.allowed.includes(file.path)) {
        findings.push({
          rule: construction.rule,
          path: file.path,
          detail: `only ${construction.allowed.join(', ')} may contain "${construction.token}"`,
        });
      }
    }
    if (construction.minimum !== undefined && count < construction.minimum) {
      findings.push({
        rule: construction.rule,
        path: construction.allowed[0] ?? entry,
        detail: `expected at least ${construction.minimum} occurrence of "${construction.token}"`,
      });
    }
  }

  for (const declaration of UNIQUE_DECLARATIONS) {
    const count = occurrenceCount(files, declaration.token);
    if (count !== 1) {
      findings.push({
        rule: declaration.rule,
        path: entry,
        detail: `expected exactly one "${declaration.token}", found ${count}`,
      });
    }
  }

  // The catalogue factory is not the only router shape: the intelligence work
  // may add `createModelRouter` or a model-scoped `createRouter`. Count both so
  // two competing router implementations cannot merge as "just another file".
  const modelRouterDeclarations = files.reduce((total, file) => {
    const modelScoped = file.path.startsWith('src/models/')
      ? file.text.split('export function createRouter(').length - 1
      : 0;
    const explicit = file.text.split('export function createModelRouter(').length - 1;
    return total + modelScoped + explicit;
  }, 0);
  if (modelRouterDeclarations > 1) {
    findings.push({
      rule: 'duplicate_model_router',
      path: 'src/models',
      detail: `expected at most one model router declaration, found ${modelRouterDeclarations}`,
    });
  }

  for (const file of files) {
    for (const factory of factoryExports(file)) {
      const references = files.filter(
        (candidate) =>
          candidate.path !== file.path &&
          new RegExp(`\\b${factory}\\b`).test(candidate.text),
      );
      if (references.length === 0) {
        findings.push({
          rule: 'unused_factory',
          path: file.path,
          detail: `exported factory ${factory} has no consumer; a capability without wiring is not implemented`,
        });
      }
    }
  }

  return findings.sort((left, right) =>
    `${left.rule}:${left.path}`.localeCompare(`${right.rule}:${right.path}`),
  );
}

export function loadRepository(root: string): Repository {
  const roots = ['src', 'packages/contracts/src', 'packages/sdk/src'];
  const files: SourceFile[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        walk(absolute);
      } else if (entry.endsWith('.ts')) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        files.push({ path: relative, text: readFileSync(absolute, 'utf8') });
      }
    }
  }

  for (const directory of roots) walk(path.join(root, directory));
  return { files: files.sort((left, right) => left.path.localeCompare(right.path)), entry: 'src/main.ts' };
}

export function formatFinding(finding: Finding): string {
  return `${finding.rule}: ${finding.path}: ${finding.detail}`;
}
