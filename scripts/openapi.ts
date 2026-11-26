import path from 'node:path';
import { buildOpenApiDocument } from '@coderax/contracts';

/** No side effects: both the writer and the drift gate import this module. */
export function openApiPath(): string {
  return path.resolve(import.meta.dirname, '..', '..', 'openapi.json');
}

export function render(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
