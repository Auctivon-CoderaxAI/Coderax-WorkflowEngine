import { CONTRACT_VERSION } from '@coderax/contracts';
import {
  importEdges,
  importSpecifiers,
  lineOf,
  listFiles,
  readRepoText,
  readText,
  repoRoot,
  report,
  resolveSourceModule,
  toRepoPath,
  type Finding,
  type Report,
} from './files.js';

/**
 * Architecture regression gate.
 *
 * The boundaries in AGENTS.md are only real if something checks them. This gate
 * fails on a second route table, a second run starter, a second model router, an
 * agent reaching storage, a hand-written API path, a provider called outside the
 * gateway, an import cycle, or a committed credential shape. It reads source text
 * rather than trusting review to notice a new edge.
 */

export type SourceFile = { path: string; text: string };

const BOUNDARIES: ReadonlyArray<{ from: string; to: readonly string[]; rule: string }> = [
  {
    from: 'src/agents/',
    to: [
      'src/orchestration/',
      'src/api/',
      'src/persistence/',
      'src/models/',
      'src/events/',
      'src/memory/',
      'src/permissions/',
    ],
    rule: 'agent-boundary',
  },
  {
    from: 'src/api/',
    to: [
      'src/persistence/',
      'src/execution/',
      'src/agents/',
      'src/models/',
      'src/events/',
      'src/memory/',
      'src/permissions/',
      'src/bootstrap/',
    ],
    rule: 'api-wiring',
  },
  {
    from: 'src/execution/',
    to: ['src/api/', 'src/orchestration/'],
    rule: 'execution-boundary',
  },
  {
    from: 'src/persistence/',
    to: [
      'src/api/',
      'src/orchestration/',
      'src/agents/',
      'src/models/',
      'src/events/',
      'src/memory/',
      'src/permissions/',
    ],
    rule: 'persistence-boundary',
  },
  {
    from: 'src/models/',
    to: [
      'src/api/',
      'src/orchestration/',
      'src/execution/',
      'src/agents/',
      'src/persistence/',
      'src/events/',
      'src/memory/',
      'src/permissions/',
      'src/observability/',
    ],
    rule: 'model-boundary',
  },
  {
    from: 'src/events/',
    to: [
      'src/api/',
      'src/orchestration/',
      'src/execution/',
      'src/agents/',
      'src/persistence/',
      'src/models/',
    ],
    rule: 'event-boundary',
  },
];

/** One owner per decision. A new caller is a design change, not a shortcut. */
const OWNERSHIP: ReadonlyArray<{
  pattern: RegExp;
  allowed: readonly string[];
  rule: string;
  why: string;
}> = [
  {
    pattern: /export function createRouteRegistry\b/g,
    allowed: ['src/api/router.ts'],
    rule: 'single-router',
    why: 'only src/api/router.ts may define the route table',
  },
  {
    pattern: /export function createRouter\b/g,
    allowed: ['src/api/router.ts'],
    rule: 'single-router',
    why: 'only src/api/router.ts may define the HTTP dispatcher',
  },
  {
    pattern: /registry\.register\(/g,
    allowed: ['src/api/routes.ts'],
    rule: 'single-route-table',
    why: 'handlers may only be registered in src/api/routes.ts',
  },
  {
    pattern: /createTaskRunner\(\s*\{/g,
    allowed: ['src/bootstrap/compose.ts'],
    rule: 'single-runner-owner',
    why: 'the run pump is constructed only by the composition root',
  },
  {
    pattern: /deps\.runner\.run\(/g,
    allowed: ['src/orchestration/service.ts'],
    rule: 'single-run-starter',
    why: 'only the orchestration service may start an execution',
  },
  {
    pattern: /deps\.tasks\.(?:create|reissue|updateFenced|abandon)\(/g,
    allowed: ['src/orchestration/service.ts'],
    rule: 'single-task-writer',
    why: 'only the orchestration service may write task state',
  },
  {
    pattern: /createModelCatalog\(\s*\{/g,
    allowed: ['src/bootstrap/compose.ts'],
    rule: 'single-model-router',
    why: 'only the composition root may construct the model router',
  },
  {
    pattern: /createBudgetLedger\(\s*\{/g,
    allowed: ['src/bootstrap/compose.ts'],
    rule: 'single-cost-ledger',
    why: 'only the composition root may construct the cost ledger',
  },
  {
    pattern: /composeApplication\(/g,
    allowed: ['src/main.ts', 'src/bootstrap/compose.ts'],
    rule: 'single-composition-root',
    why: 'the application is composed once, by the entry point',
  },
  {
    pattern: /allowPaid:\s*true/g,
    allowed: [],
    rule: 'zero-cost-literal',
    why: 'paid routing must not be representable',
  },
];

const FORBIDDEN_LITERALS: ReadonlyArray<{
  pattern: RegExp;
  allowed?: readonly string[];
  rule: string;
  why: string;
}> = [
  {
    pattern: /['"]\/v1\//g,
    rule: 'catalogue-is-the-only-route-source',
    why: 'HTTP paths are declared only in packages/contracts',
  },
  {
    pattern: /\bprocess\.env\b/g,
    allowed: ['src/main.ts', 'src/bootstrap/compose.ts', 'src/configuration/load.ts'],
    rule: 'env-at-the-edge',
    why: 'environment variables are read only at startup',
  },
  {
    pattern: /\bnode:child_process\b/g,
    rule: 'no-process-spawn',
    why: 'the engine must not spawn a process',
  },
  {
    pattern: /\bfetch\s*\(/g,
    allowed: ['src/agents/native/gateway.ts'],
    rule: 'single-egress',
    why: 'the only outbound HTTP call is the injected model gateway',
  },
];

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; rule: string; why: string }> = [
  {
    pattern: /(?:CODERAX_OWNER_TOKEN|CODERAX_INFERENCE_KEY)\s*=\s*[A-Za-z0-9]/g,
    rule: 'committed-secret',
    why: 'a credential value appears to be assigned in source',
  },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, rule: 'committed-secret', why: 'provider key literal' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/g, rule: 'committed-secret', why: 'GitHub token literal' },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    rule: 'committed-secret',
    why: 'private key material',
  },
];

export function findBoundaryViolations(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const rules = BOUNDARIES.filter((boundary) => file.path.startsWith(boundary.from));
    if (rules.length === 0) continue;
    for (const edge of importEdges(file.text)) {
      // A type-only import is a shared contract, not a runtime dependency.
      if (edge.typeOnly) continue;
      const target = resolveSourceModule(`${repoRoot()}/${file.path}`, edge.specifier);
      if (!target) continue;
      const targetPath = toRepoPath(target);
      for (const boundary of rules) {
        if (!boundary.to.some((prefix) => targetPath.startsWith(prefix))) continue;
        findings.push({
          rule: boundary.rule,
          detail: `${file.path} imports ${targetPath}; ${boundary.from} may not depend on ${boundary.to.join(', ')}`,
        });
      }
    }
  }
  return findings;
}

export function findOwnershipViolations(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of OWNERSHIP) {
    for (const file of files) {
      if (rule.allowed.includes(file.path)) continue;
      for (const match of file.text.matchAll(rule.pattern)) {
        findings.push({
          rule: rule.rule,
          detail: `${file.path}:${lineOf(file.text, match.index ?? 0)} — ${rule.why}`,
        });
      }
    }
  }
  return findings;
}

export function findForbiddenLiterals(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of FORBIDDEN_LITERALS) {
    for (const file of files) {
      if (rule.allowed?.includes(file.path)) continue;
      for (const match of file.text.matchAll(rule.pattern)) {
        findings.push({
          rule: rule.rule,
          detail: `${file.path}:${lineOf(file.text, match.index ?? 0)} — ${rule.why}`,
        });
      }
    }
  }
  for (const rule of SECRET_PATTERNS) {
    for (const file of files) {
      for (const match of file.text.matchAll(rule.pattern)) {
        findings.push({
          rule: rule.rule,
          detail: `${file.path}:${lineOf(file.text, match.index ?? 0)} — ${rule.why}`,
        });
      }
    }
  }
  return findings;
}

export function findCycles(files: readonly SourceFile[]): Finding[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    for (const specifier of importSpecifiers(file.text)) {
      const resolved = resolveSourceModule(`${repoRoot()}/${file.path}`, specifier);
      if (!resolved) continue;
      const target = toRepoPath(resolved);
      if (byPath.has(target)) targets.push(target);
    }
    edges.set(file.path, targets);
  }

  const findings: Finding[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    const current = state.get(node);
    if (current === 'done') return;
    if (current === 'visiting') {
      const start = stack.indexOf(node);
      findings.push({
        rule: 'import-cycle',
        detail: [...stack.slice(start), node].join(' -> '),
      });
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const target of edges.get(node) ?? []) visit(target);
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of [...edges.keys()].sort()) visit(node);
  return findings;
}

function packageField(rel: string, field: string): string | null {
  try {
    const parsed = JSON.parse(readRepoText(rel)) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function contractVersionChecks(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of ['packages/contracts/package.json', 'packages/sdk/package.json']) {
    const version = packageField(rel, 'version');
    if (version !== CONTRACT_VERSION) {
      findings.push({
        rule: 'contract-version',
        detail: `${rel} version ${version ?? 'missing'} must equal CONTRACT_VERSION ${CONTRACT_VERSION}`,
      });
    }
  }
  return findings;
}

export function checkStructure(): Report {
  const files: SourceFile[] = listFiles('src').map((file) => ({
    path: toRepoPath(file),
    text: readText(file),
  }));
  if (files.length === 0) {
    return report([{ rule: 'structure', detail: 'no engine source was found to check' }]);
  }
  const findings = [
    ...findBoundaryViolations(files),
    ...findOwnershipViolations(files),
    ...findForbiddenLiterals(files),
    ...findCycles(files),
    ...contractVersionChecks(),
  ];
  const root = JSON.parse(readRepoText('package.json')) as { private?: boolean };
  if (root.private !== true) {
    findings.push({ rule: 'package-private', detail: 'the root package must stay private' });
  }
  return report(findings);
}

