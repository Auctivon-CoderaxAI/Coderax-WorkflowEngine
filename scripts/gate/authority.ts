import path from 'node:path';
import ts from 'typescript';
import { repoRoot, report, type Finding, type Report } from './files.js';

/**
 * Capability ownership by type, not by file name.
 *
 * A competing implementation is not defined by the name of its factory. It is a
 * value whose type satisfies a capability contract that the composition root is
 * only allowed to instantiate once. TypeScript's checker answers that question
 * directly, so renaming `createModelRouter` or hiding it behind a different
 * factory does not evade the gate. Provider adapters return a different port
 * (`ProviderAdapter`), so they are not classified as model routers, and the
 * memory/Mongo persistence drivers share a repository type by design rather than
 * competing for a decision authority.
 *
 * The capability list is additive: a contract that does not exist yet is
 * skipped, and it begins to enforce the moment a branch introduces it. That is
 * what lets this gate land before the router and supervisor branches without
 * rejecting them for being absent.
 */

export type CapabilitySpec = {
  capability: string;
  typeName: string;
  /** Where the capability contract is declared; this avoids same-name collisions. */
  typePathPrefix: string;
  /** Legitimate implementations that are not authorities (fallbacks/adapters). */
  supporting?: readonly string[];
};

export const CAPABILITIES: readonly CapabilitySpec[] = Object.freeze([
  {
    capability: 'model_router',
    typeName: 'ModelCatalog',
    typePathPrefix: 'src/models/',
  },
  {
    capability: 'model_router',
    typeName: 'ModelRouter',
    typePathPrefix: 'src/models/',
  },
  {
    // The intelligence branches named their model-side router `Router`; the
    // path prefix keeps the HTTP Router (src/api) out of this capability.
    capability: 'model_router',
    typeName: 'Router',
    typePathPrefix: 'src/models/',
  },
  {
    capability: 'quota_ledger',
    typeName: 'BudgetLedger',
    typePathPrefix: 'src/models/',
  },
  {
    capability: 'task_runner',
    typeName: 'TaskRunner',
    typePathPrefix: 'src/execution/',
  },
  {
    capability: 'scheduler',
    typeName: 'TaskScheduler',
    typePathPrefix: 'src/scheduling/',
  },
  {
    capability: 'event_bus',
    typeName: 'EventBus',
    typePathPrefix: 'src/events/',
  },
  {
    capability: 'application_service',
    typeName: 'ApplicationService',
    typePathPrefix: 'src/orchestration/',
  },
  {
    capability: 'http_router',
    typeName: 'Router',
    typePathPrefix: 'src/api/',
  },
  {
    capability: 'route_registry',
    typeName: 'RouteRegistry',
    typePathPrefix: 'src/api/',
  },
  {
    capability: 'planner',
    typeName: 'Planner',
    typePathPrefix: 'src/agents/native/',
  },
  {
    capability: 'execution_supervisor',
    typeName: 'ExecutionSupervisor',
    typePathPrefix: 'src/execution/',
  },
  {
    // The older security branch named its supervisor `RunSupervisor`. Counting
    // both contracts means two differently named supervisors still fail.
    capability: 'execution_supervisor',
    typeName: 'RunSupervisor',
    typePathPrefix: 'src/execution/',
  },
]);

/** Types that decide a route; ModelCatalog is the read port, not a decision. */
const ROUTING_DECISIONS: ReadonlySet<string> = new Set(['ModelRouter', 'Router']);

export type CapabilityOwner = {
  capability: string;
  exportName: string;
  file: string;
  typeName: string;
};

export type CapabilityFinding = Finding;

function relative(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}

function readConfig(root: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json is required for the capability gate');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  return { fileNames: parsed.fileNames, options: parsed.options };
}

export function createProgram(root: string): ts.Program {
  const { fileNames, options } = readConfig(root);
  return ts.createProgram({
    rootNames: fileNames,
    options: { ...options, noEmit: true },
  });
}

function declaredType(
  program: ts.Program,
  checker: ts.TypeChecker,
  root: string,
  spec: CapabilitySpec,
): ts.Type | null {
  for (const source of program.getSourceFiles()) {
    const file = relative(root, source.fileName);
    if (!file.startsWith(spec.typePathPrefix) || file.endsWith('.d.ts')) continue;
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const symbol of checker.getExportsOfModule(module)) {
      if (symbol.name !== spec.typeName) continue;
      const declaration = symbol.declarations?.find(
        (candidate) =>
          ts.isTypeAliasDeclaration(candidate) ||
          ts.isInterfaceDeclaration(candidate) ||
          ts.isClassDeclaration(candidate),
      );
      if (!declaration) continue;
      return checker.getTypeAtLocation(declaration);
    }
  }
  return null;
}

/** A module export's value type, or a factory's return type. */
function valueType(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  declaration: ts.Declaration,
): ts.Type {
  let type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const call = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
  if (call) type = call.getReturnType();
  const construct = checker.getSignaturesOfType(type, ts.SignatureKind.Construct)[0];
  if (construct) type = checker.getReturnTypeOfSignature(construct);
  return type;
}

export function inspectCapabilities(
  program: ts.Program,
  root: string,
): { owners: CapabilityOwner[]; findings: CapabilityFinding[] } {
  const checker = program.getTypeChecker();
  const unresolved =
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.Never |
    ts.TypeFlags.TypeParameter;
  const targets = CAPABILITIES.map((spec) => ({
    spec,
    type: declaredType(program, checker, root, spec),
  })).filter(
    (entry): entry is { spec: CapabilitySpec; type: ts.Type } =>
      entry.type !== null && (entry.type.flags & unresolved) === 0,
  );

  const owners: CapabilityOwner[] = [];
  for (const source of program.getSourceFiles()) {
    const file = relative(root, source.fileName);
    if (!file.startsWith('src/') || file.endsWith('.d.ts')) continue;
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const symbol of checker.getExportsOfModule(module)) {
      // Interfaces, aliases and types have no runtime implementation to count.
      if (
        symbol.flags &
        (ts.SymbolFlags.TypeAlias |
          ts.SymbolFlags.Interface |
          ts.SymbolFlags.TypeParameter |
          ts.SymbolFlags.Namespace)
      ) {
        continue;
      }
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) continue;
      let type: ts.Type;
      try {
        type = valueType(checker, symbol, declaration);
      } catch {
        continue;
      }
      // An error/unresolved type is not evidence that a value implements every
      // capability; TypeScript's `any` is assignable to everything.
      if ((type.flags & unresolved) !== 0) continue;
      for (const target of targets) {
        if (!checker.isTypeAssignableTo(type, target.type)) continue;
        owners.push({
          capability: target.spec.capability,
          exportName: symbol.name,
          file,
          typeName: target.spec.typeName,
        });
      }
    }
  }

  const unique = new Map(
    owners.map((owner) => [`${owner.capability}|${owner.file}|${owner.exportName}`, owner]),
  );
  const normalized = [...unique.values()];
  const findings: CapabilityFinding[] = [];
  const byCapability = new Map<string, CapabilityOwner[]>();
  for (const owner of normalized) {
    const list = byCapability.get(owner.capability) ?? [];
    list.push(owner);
    byCapability.set(owner.capability, list);
  }
  for (const [capability, list] of byCapability) {
    const spec = CAPABILITIES.find((candidate) => candidate.capability === capability);
    // A catalogue is a projection of the router, not a second decision. Once a
    // routing-decision contract exists (ModelRouter or the model-scoped Router),
    // values typed as ModelCatalog are supporting; on main, where no decision
    // contract exists, ModelCatalog is itself the authority. Two decision values
    // still fail whichever contract they use.
    const authorities =
      capability === 'model_router'
        ? (() => {
            const decisions = list.filter((owner) => ROUTING_DECISIONS.has(owner.typeName));
            return decisions.length > 0 ? decisions : list;
          })()
        : list.filter((owner) => !(spec?.supporting ?? []).includes(owner.file));
    if (authorities.length > 1) {
      findings.push({
        rule: `duplicate_${capability}`,
        detail: `expected at most one authority, found ${authorities
          .map((owner) => `${owner.file}:${owner.exportName} (${owner.typeName})`)
          .join(', ')}`,
      });
    }
  }
  return {
    owners: normalized.sort((left, right) =>
      `${left.capability}:${left.file}:${left.exportName}`.localeCompare(
        `${right.capability}:${right.file}:${right.exportName}`,
      ),
    ),
    findings: findings.sort((left, right) =>
      `${left.rule}:${left.detail}`.localeCompare(`${right.rule}:${right.detail}`),
    ),
  };
}

export function checkAuthorities(): Report {
  const root = repoRoot();
  const program = createProgram(root);
  return report(inspectCapabilities(program, root).findings);
}

/** Readable for the gate output and the compatibility matrix; not a decision. */
export function capabilityReport(): string {
  const root = repoRoot();
  const program = createProgram(root);
  const { owners } = inspectCapabilities(program, root);
  const lines = owners.map(
    (owner) => `${owner.capability}: ${owner.file}:${owner.exportName} (${owner.typeName})`,
  );
  return lines.length > 0 ? lines.join('\n') : 'no capability implementations found';
}
