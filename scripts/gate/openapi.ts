import { readFileSync } from 'node:fs';
import { buildOpenApiDocument, ROUTES } from '@coderax/contracts';
import { openApiPath, render } from '../openapi.js';
import { report, type Finding, type Report } from './files.js';

/**
 * OpenAPI drift gate.
 *
 * The committed document is the published contract. It must be byte-identical to
 * the generator's output, must parse, and must contain exactly the catalogue's
 * paths and methods — an operation cannot be documented away by hand.
 */
export function checkOpenApi(): Report {
  const findings: Finding[] = [];
  let committed: string;
  try {
    committed = readFileSync(openApiPath(), 'utf8');
  } catch {
    return report([{ rule: 'openapi-missing', detail: 'openapi.json is missing; run npm run openapi:write' }]);
  }
  if (committed !== render()) {
    findings.push({
      rule: 'openapi-drift',
      detail: 'openapi.json does not match the contracts; run npm run openapi:write',
    });
  }

  let document: { openapi?: unknown; paths?: Record<string, Record<string, { operationId?: unknown }>> };
  try {
    document = JSON.parse(committed) as typeof document;
  } catch {
    return report([...findings, { rule: 'openapi-invalid', detail: 'openapi.json is not valid JSON' }]);
  }
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    findings.push({ rule: 'openapi-version', detail: 'openapi.json is not an OpenAPI 3.x document' });
  }

  const published = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      published.add(`${method.toUpperCase()} ${path}`);
    }
  }
  for (const route of ROUTES) {
    if (!published.has(`${route.method} ${route.path}`)) {
      findings.push({
        rule: 'openapi-missing-operation',
        detail: `${route.method} ${route.path} is absent from openapi.json`,
      });
    }
  }
  if (JSON.stringify(document) !== JSON.stringify(buildOpenApiDocument())) {
    findings.push({
      rule: 'openapi-shape',
      detail: 'the committed document parses but does not equal the generated document',
    });
  }
  return report(findings);
}
