import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const files = process.argv.slice(2).map((file) => path.resolve(file));
const passed = new Set<string>();
const stream = run({ files });
stream.on('test:summary', ({ file, success, counts }) => {
  if (file && success && counts.passed > 0 && counts.skipped === 0 && counts.todo === 0) {
    passed.add(file);
  }
});
stream.on('test:fail', () => {
  process.exitCode = 1;
});
const output = stream.compose(spec);
output.on('end', () => {
  for (const file of files) {
    if (!passed.has(file)) {
      process.stderr.write(`required live suite did not complete without skips or todos: ${file}\n`);
      process.exitCode = 1;
    }
  }
});
output.pipe(process.stdout);
