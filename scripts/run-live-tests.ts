import path from 'node:path';
import { run, type EventData } from 'node:test';
import { spec } from 'node:test/reporters';

const files = process.argv.slice(2).map((file) => path.resolve(file));
const passed = new Set<string>();
const incomplete = new Set<string>();
const stream = run({ files });
stream.on('test:summary', ({ file, success, counts }) => {
  if (file && success && counts.passed > 0 && counts.skipped === 0 && counts.todo === 0) {
    passed.add(file);
  }
});
function recordDirectives({ file, skip, todo }: EventData.TestPass | EventData.TestFail): void {
  if (skip === true || typeof skip === 'string' || todo === true || typeof todo === 'string') {
    if (file) incomplete.add(file);
    process.exitCode = 1;
  }
}
stream.on('test:pass', recordDirectives);
stream.on('test:fail', (result) => {
  recordDirectives(result);
  process.exitCode = 1;
});
const output = stream.compose(spec);
output.on('end', () => {
  for (const file of files) {
    if (!passed.has(file) || incomplete.has(file)) {
      process.stderr.write(`required live suite did not complete without skips or todos: ${file}\n`);
      process.exitCode = 1;
    }
  }
});
output.pipe(process.stdout);
