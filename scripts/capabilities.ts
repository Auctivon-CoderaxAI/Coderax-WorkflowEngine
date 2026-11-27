import path from 'node:path';
import ts from 'typescript';
import { authorityFor } from './ownership.js';

/**
 * Capability ownership by type, not by file name.
 *
 * A competing implementation is not defined by the name of its factory. It is a
 * value whose type satisfies a capability contract that the composition root is
 * only allowed to instantiate once. TypeScript's checker answers that question
 * directly, so renaming `createModelRouter` or hiding it behind a different
 * factory does not evade the gate. Provider adapters return a different port
 * (`ProviderAdapter`), so they are not classified as model routers.
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
    capability: 'task_runner',
    typeName: 'TaskRunner',
    typePathPrefix: 'src/execution/',
  },
  {
    capability: 'scheduler',
    typeName: 'TaskScheduler',
    typePathPrefix: 'src/scheduling/',
  },
  // PermissionStore has legitimate memory and MongoDB drivers; counting both
  // would reject a valid persistence choice. The decision layer (PermissionGate)
  // is the authority that must be single.
  {
    capability: 'permission_gate',
    typeName: 'PermissionGate',
    typePathPrefix: 'src/permissions/',
  },
  {
    capability: 'quota_ledger',
    typeName: 'BudgetLedger',
    typePathPrefix: 'src/models/',
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
    // The security branch introduced its own execution-scoped supervisor. It is
    // a legitimate isolated branch, but after PR #5 lands there must be one
    // authority; the ownership probe is what forces that reconciliation.
    capability: 'execution_supervisor',
    typeName: 'RunSupervisor',
    typePathPrefix: 'src/execution/',
  },
  {
    // PR #5's execution-scoped broker is a second authorization authority when
    // combined with PermissionGate. Both may be legitimate layers on their own
    // branch; a merged tree must choose one decision chain.
    capability: 'permission_gate',
    typeName: 'CapabilityBroker',
    typePathPrefix: 'src/execution/',
  },
  {
    capability: 'artifact_service',
    typeName: 'ArtifactService',
    typePathPrefix: 'src/artifacts/',
  },
  {
    // Agent discovery is the capability registry the API and native team use.
    // A second registry is a competing discovery path even when it is called a
    // map, a broker or a wrapper.
    capability: 'capability_registry',
    typeName: 'AgentRegistry',
    typePathPrefix: 'src/agents/',
  },
  {
    capability: 'schedule_engine',
    typeName: 'ScheduleEngine',
    typePathPrefix: 'src/scheduling/',
  },
  {
    capability: 'event_log',
    typeName: 'EventLog',
    typePathPrefix: 'src/events/',
    // Memory and Mongo are persistence drivers for the same log contract, not
    // competing event-delivery authorities.
    supporting: ['src/persistence/mongo-events.ts'],
  },
  {
    capability: 'media_service',
    typeName: 'MediaService',
    typePathPrefix: 'src/media/',
  },
  {
    capability: 'creative_service',
    typeName: 'CreativeService',
    typePathPrefix: 'src/creative/',
  },
]);

export type CapabilityOwner = {
  capability: string;
  exportName: string;
  file: string;
  typeName: string;
};

export type CapabilityFinding = {
  rule: string;
  path: string;
  detail: string;
};

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
  const unresolved = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter;
  const targets = CAPABILITIES.map((spec) => ({
    spec,
    type: declaredType(program, checker, root, spec),
  })).filter(
    (entry): entry is { spec: CapabilitySpec; type: ts.Type } =>
      entry.type !== null && (entry.type.flags & unresolved) === 0,
  );

  const unique = new Map<string, Map<ts.Declaration, CapabilityOwner>>();
  for (const source of program.getSourceFiles()) {
    const file = relative(root, source.fileName);
    if (!file.startsWith('src/') || file.endsWith('.d.ts')) continue;
    const module = checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
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
      if (!declaration || !(symbol.flags & ts.SymbolFlags.Value)) continue;
      const implementationFile = relative(root, declaration.getSourceFile().fileName);
      if (!implementationFile.startsWith('src/') || implementationFile.endsWith('.d.ts')) continue;
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
        const capability = target.spec.capability;
        const implementations = unique.get(capability) ?? new Map<ts.Declaration, CapabilityOwner>();
        implementations.set(declaration, {
          capability,
          exportName: symbol.name,
          file: implementationFile,
          typeName: target.spec.typeName,
        });
        unique.set(capability, implementations);
      }
    }
  }

  const normalized = [...unique.values()].flatMap((implementations) => [...implementations.values()]);
  const findings: CapabilityFinding[] = [];
  const byCapability = new Map<string, CapabilityOwner[]>();
  for (const owner of normalized) {
    const list = byCapability.get(owner.capability) ?? [];
    list.push(owner);
    byCapability.set(owner.capability, list);
  }
  for (const [capability, list] of byCapability) {
    const spec = CAPABILITIES.find((candidate) => candidate.capability === capability);
    const authorities = list.filter(
      (owner) => !(spec?.supporting ?? []).includes(owner.file),
    );
    if (authorities.length > 1) {
      const owner = authorityFor(capability);
      findings.push({
        rule: `duplicate_${capability}`,
        path: authorities[0]?.file ?? 'src',
        detail: `expected at most one authority, found ${authorities
          .map((candidate) => `${candidate.file}:${candidate.exportName}`)
          .join(', ')}${owner ? `; authoritative owner: ${owner.owner} (${owner.branch})` : ''}`,
      });
    }
  }
  return { owners: normalized.sort((left, right) => `${left.capability}:${left.file}:${left.exportName}`.localeCompare(`${right.capability}:${right.file}:${right.exportName}`)), findings };
}

/** Convenience for the command gate and tests. */
export function checkCapabilities(root: string): CapabilityFinding[] {
  const program = createProgram(root);
  return inspectCapabilities(program, root).findings;
}

/** Readable for the gate output; not used to make a decision. */
export function capabilityReport(root: string): string {
  const program = createProgram(root);
  const { owners } = inspectCapabilities(program, root);
  const lines = owners.map((owner) => {
    const authority = authorityFor(owner.capability);
    return `${owner.capability}: ${owner.file}:${owner.exportName} (${owner.typeName})${
      authority ? ` [owner: ${authority.owner}]` : ''
    }`;
  });
  return lines.length > 0 ? lines.join('\n') : 'no capability implementations found';
}
