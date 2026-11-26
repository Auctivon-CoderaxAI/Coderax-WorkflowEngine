import {
  importSpecifiers,
  listFiles,
  readText,
  repoRoot,
  report,
  resolveSourceModule,
  toRepoPath,
  type Finding,
  type Report,
} from './files.js';

/**
 * Disconnected-capability gate.
 *
 * A module, factory or exported helper that nothing reaches is not a feature; it
 * is code that cannot be exercised, reviewed against callers, or covered by the
 * acceptance suite. Reachability is computed from the real import graph starting
 * at the entry point, not from a hand-maintained list.
 *
 * A short, reviewed exception list exists for parity scaffolding that is kept for
 * a future wiring step. Exceptions are warnings: visible on every run, and never
 * allowed to hide a new orphan.
 */

/** Modules that are intentionally not wired yet, with the reason and the gap. */
export const KNOWN_DISCONNECTED: ReadonlyMap<string, string> = new Map([
  [
    'src/execution/retry.ts',
    'bounded same-engine retry is preserved for the migration but not yet invoked by orchestration; parity row 11 is reported as unwired, not preserved',
  ],
]);

/** Named exports kept for a documented migration path, with the reason. */
export const KNOWN_UNUSED_EXPORTS: ReadonlyMap<string, string> = new Map([
  [
    'adaptMongoWorkRunMethods',
    'adapter from the verified Coderax Work-run methods; kept for the persistence migration until a caller adopts it',
  ],
]);

const ENTRY = 'src/main.ts';

function reachableModules(files: ReadonlyArray<{ path: string; text: string }>): Set<string> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const reached = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || reached.has(current)) continue;
    const file = byPath.get(current);
    if (!file) continue;
    reached.add(current);
    for (const specifier of importSpecifiers(file.text)) {
      const resolved = resolveSourceModule(`${repoRoot()}/${file.path}`, specifier);
      if (!resolved) continue;
      const target = toRepoPath(resolved);
      if (byPath.has(target) && !reached.has(target)) queue.push(target);
    }
  }
  return reached;
}

function occurrenceCount(name: string, corpus: readonly string[]): number {
  const pattern = new RegExp(`\\b${name}\\b`, 'g');
  let count = 0;
  for (const text of corpus) count += [...text.matchAll(pattern)].length;
  return count;
}

export function checkReachability(): Report {
  const sources = listFiles('src').map((file) => ({ path: toRepoPath(file), text: readText(file) }));
  if (sources.length === 0) {
    return report([{ rule: 'reachability', detail: 'no engine source was found to check' }]);
  }
  const reached = reachableModules(sources);
  const findings: Finding[] = [];
  const warnings: Finding[] = [];

  for (const file of sources) {
    if (reached.has(file.path)) continue;
    const reason = KNOWN_DISCONNECTED.get(file.path);
    if (reason) {
      warnings.push({ rule: 'known-disconnected-module', detail: `${file.path} — ${reason}` });
    } else {
      findings.push({
        rule: 'unreachable-module',
        detail: `${file.path} is not reachable from ${ENTRY}`,
      });
    }
  }

  const corpus = [
    ...sources,
    ...listFiles('scripts').map((file) => ({ path: toRepoPath(file), text: readText(file) })),
    ...listFiles('packages').map((file) => ({ path: toRepoPath(file), text: readText(file) })),
    ...listFiles('tests').map((file) => ({ path: toRepoPath(file), text: readText(file) })),
  ];
  const texts = corpus.map((file) => file.text);

  for (const file of sources) {
    if (KNOWN_DISCONNECTED.has(file.path)) continue;
    for (const match of file.text.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z0-9_]+)/gm,
    )) {
      const name = match[1];
      if (!name) continue;
      if (KNOWN_UNUSED_EXPORTS.has(name)) {
        warnings.push({
          rule: 'known-unused-export',
          detail: `${file.path} ${name} — ${KNOWN_UNUSED_EXPORTS.get(name)}`,
        });
        continue;
      }
      if (occurrenceCount(name, texts) <= 1) {
        findings.push({
          rule: 'unused-export',
          detail: `${file.path} exports ${name}, which nothing references`,
        });
      }
    }
  }

  return report(findings, warnings);
}
