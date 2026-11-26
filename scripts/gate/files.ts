import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Shared file access for the quality gates.
 *
 * A gate reports findings instead of throwing, so one run names every violation
 * rather than stopping at the first. Findings are errors; warnings are documented
 * debt that is printed and does not fail the build.
 */

export type Finding = { rule: string; detail: string };

export type Report = { findings: Finding[]; warnings: Finding[] };

export function report(findings: Finding[] = [], warnings: Finding[] = []): Report {
  return { findings, warnings };
}

/** The repository root from either `dist/scripts/gate` or a compiled test. */
export function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

export function listFiles(relDir: string, extensions: readonly string[] = ['.ts']): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
  };
  walk(path.join(repoRoot(), relDir));
  return found.sort();
}

export function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

export function readRepoText(rel: string): string {
  return readText(path.join(repoRoot(), rel));
}

export function toRepoPath(file: string): string {
  return path.relative(repoRoot(), file).split(path.sep).join('/');
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export type ImportEdge = { specifier: string; typeOnly: boolean };

/**
 * Static imports with their runtime/type-only distinction.
 *
 * `import type` creates no runtime coupling, so an architecture boundary can
 * permit a shared type while still refusing a real call into the module.
 */
export function importEdges(text: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
    if (match[2]) edges.push({ specifier: match[2], typeOnly: Boolean(match[1]) });
  }
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    if (match[1]) edges.push({ specifier: match[1], typeOnly: false });
  }
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1]) edges.push({ specifier: match[1], typeOnly: false });
  }
  return edges;
}

/**
 * Static import specifiers, including side-effect and dynamic imports.
 *
 * The first pattern is bounded by `;` so an import without `from` cannot swallow
 * a later statement and invent an edge that does not exist.
 */
export function importSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return [...specs];
}

/**
 * Resolves a relative TypeScript import to the file it names.
 *
 * An ESM source specifier ends in `.js` while the file on disk is `.ts`, so both
 * spellings are tried. A bare package specifier is not a repository edge and is
 * returned as null.
 */
export function resolveSourceModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next spelling; absence is reported by the caller.
    }
  }
  return null;
}

/** Resolves a compiled relative import, used to check emitted artifacts. */
export function resolveEmittedModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

export function exists(rel: string): boolean {
  try {
    return statSync(path.join(repoRoot(), rel)).isFile();
  } catch {
    return false;
  }
}
