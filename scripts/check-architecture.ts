import path from 'node:path';
import { checkArchitecture, formatFinding, loadRepository } from './architecture.js';
import { checkCapabilities } from './capabilities.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const findings = [
  ...checkArchitecture(loadRepository(root)),
  ...checkCapabilities(root),
];

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`${formatFinding(finding)}\n`);
  process.stderr.write(
    `architecture gate failed with ${findings.length} finding(s); ` +
      'fix the wiring instead of adding an exception\n',
  );
  process.exit(1);
}

process.stdout.write('architecture gate passed: one owner per capability, no boundary violations\n');
