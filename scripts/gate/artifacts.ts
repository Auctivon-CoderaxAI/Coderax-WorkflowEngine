import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import {
  importSpecifiers,
  listFiles,
  readText,
  repoRoot,
  report,
  resolveEmittedModule,
  toRepoPath,
  type Finding,
  type Report,
} from './files.js';

/**
 * Package artifact integrity gate.
 *
 * A green `tsc` run is not proof that what will ship is loadable. Every declared
 * package entry point must exist, every source file must have emitted JavaScript
 * and declarations, every relative import in the emitted tree must resolve, and
 * the unpublished workspace packages must stay private.
 */

type Manifest = {
  name?: string;
  private?: boolean;
  main?: string;
  types?: string;
  exports?: Record<string, string | Record<string, string>>;
};

function compiledCounterpart(relSource: string): string | null {
  if (relSource.startsWith('src/') || relSource.startsWith('scripts/')) {
    return `dist/${relSource}`;
  }
  for (const pkg of ['packages/contracts', 'packages/sdk']) {
    if (relSource.startsWith(`${pkg}/src/`)) {
      return `${pkg}/dist/${relSource.slice(`${pkg}/src/`.length)}`;
    }
  }
  return null;
}

function declaredTargets(manifest: Manifest): string[] {
  const targets = [manifest.main, manifest.types].filter((value): value is string => !!value);
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') {
      targets.push(value);
      continue;
    }
    for (const target of Object.values(value)) {
      if (typeof target === 'string') targets.push(target);
    }
  }
  return targets;
}

function packageFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const rel of ['packages/contracts/package.json', 'packages/sdk/package.json']) {
    const manifest = JSON.parse(readText(path.join(repoRoot(), rel))) as Manifest;
    if (manifest.private !== true) {
      findings.push({ rule: 'artifact-publishable', detail: `${rel} must stay private` });
    }
    const packageDir = path.dirname(path.join(repoRoot(), rel));
    for (const target of declaredTargets(manifest)) {
      if (!target.startsWith('./')) {
        findings.push({
          rule: 'artifact-target',
          detail: `${rel} declares an export that is not package-relative: ${target}`,
        });
        continue;
      }
      const resolved = path.resolve(packageDir, target);
      if (!resolved.startsWith(packageDir + path.sep)) {
        findings.push({ rule: 'artifact-escape', detail: `${rel} exports outside the package: ${target}` });
        continue;
      }
      try {
        if (statSync(resolved).size === 0) {
          findings.push({ rule: 'artifact-empty', detail: `${rel} declares ${target}, which is empty` });
        }
      } catch {
        findings.push({ rule: 'artifact-missing', detail: `${rel} declares ${target}, which does not exist` });
      }
    }
  }
  return findings;
}

function emittedFindings(): Finding[] {
  const findings: Finding[] = [];
  const sources = [
    ...listFiles('src'),
    ...listFiles('scripts'),
    ...listFiles('packages/contracts/src'),
    ...listFiles('packages/sdk/src'),
  ];
  for (const file of sources) {
    const rel = toRepoPath(file);
    const compiled = compiledCounterpart(rel);
    if (!compiled) continue;
    for (const target of [compiled.replace(/\.ts$/, '.js'), compiled.replace(/\.ts$/, '.d.ts')]) {
      let size = 0;
      try {
        size = statSync(path.join(repoRoot(), target)).size;
      } catch {
        size = 0;
      }
      if (size === 0) {
        findings.push({ rule: 'artifact-missing', detail: `${rel} did not emit ${target}` });
      }
    }
  }
  if (findings.length > 0) return findings;

  for (const file of [
    ...buildFiles('dist/src'),
    ...buildFiles('dist/scripts'),
    ...buildFiles('packages/contracts/dist'),
    ...buildFiles('packages/sdk/dist'),
  ]) {
    const text = readText(file);
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith('.')) continue;
      if (!resolveEmittedModule(file, specifier)) {
        findings.push({
          rule: 'artifact-unresolved-import',
          detail: `${toRepoPath(file)} imports ${specifier}, which does not resolve`,
        });
      }
    }
  }
  return findings;
}

/** The build tree is a deliverable, so it is listed even though git ignores it. */
function buildFiles(relDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) found.push(full);
    }
  };
  walk(path.join(repoRoot(), relDir));
  return found.sort();
}

function openApiFindings(): Finding[] {
  try {
    const document = JSON.parse(readText(path.join(repoRoot(), 'openapi.json'))) as {
      openapi?: unknown;
    };
    if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
      return [{ rule: 'artifact-openapi', detail: 'openapi.json is not an OpenAPI 3.x document' }];
    }
    if (readFileSync(path.join(repoRoot(), 'openapi.json')).length === 0) {
      return [{ rule: 'artifact-openapi', detail: 'openapi.json is empty' }];
    }
    return [];
  } catch {
    return [{ rule: 'artifact-openapi', detail: 'openapi.json is missing or invalid' }];
  }
}

export function checkArtifacts(): Report {
  return report([...packageFindings(), ...emittedFindings(), ...openApiFindings()]);
}
