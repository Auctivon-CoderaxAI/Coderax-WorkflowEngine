import { readFileSync } from 'node:fs';
import { openApiPath, render } from './openapi.js';

let committed: string;
try {
  committed = readFileSync(openApiPath(), 'utf8');
} catch {
  process.stderr.write('openapi.json is missing; run "npm run openapi:write"\n');
  process.exit(1);
}

if (committed !== render()) {
  process.stderr.write(
    'openapi.json does not match the contracts: run "npm run openapi:write" and commit the result\n',
  );
  process.exit(1);
}
process.stdout.write('openapi.json matches the published contracts\n');
