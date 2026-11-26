import { writeFileSync } from 'node:fs';
import { openApiPath, render } from './openapi.js';

writeFileSync(openApiPath(), render(), 'utf8');
process.stdout.write(`wrote ${openApiPath()}\n`);
