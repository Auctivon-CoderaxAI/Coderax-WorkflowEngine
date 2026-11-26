import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GATES, planGates, type GatePlan } from './gates.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const argument = process.argv[2] ?? 'all';

function runPlan(plan: GatePlan): boolean {
  process.stdout.write(`\n▶ ${plan.gate.id}: ${plan.gate.title}\n`);
  if (plan.tests.length > 0) {
    const relative = plan.tests.map((file) => path.relative(root, file));
    const result = spawnSync(process.execPath, ['--test', ...relative], {
      cwd: root,
      stdio: 'inherit',
      // A required live gate must fail, not skip, when infrastructure is absent.
      env: plan.gate.live
        ? { ...process.env, CODERAX_REQUIRE_MONGO: '1' }
        : process.env,
    });
    if (result.status !== 0) return false;
  }
  if (plan.command) {
    const result = spawnSync(process.execPath, [plan.command], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) return false;
  }
  return true;
}

try {
  const { plans, unclaimed } = planGates(root);

  if (argument === 'list') {
    for (const gate of GATES) {
      process.stdout.write(
        `${gate.id.padEnd(14)} ${gate.live ? 'live ' : '     '} ${gate.title}\n`,
      );
    }
    process.exit(0);
  }

  if (argument === 'coverage') {
    if (unclaimed.length > 0) {
      for (const file of unclaimed) process.stderr.write(`unassigned test: ${file}\n`);
      process.stderr.write('every test must belong to exactly one quality gate\n');
      process.exit(1);
    }
    const total = plans.reduce((count, plan) => count + plan.tests.length, 0);
    process.stdout.write(`gate coverage passed: ${total} test file(s) assigned, none unclaimed\n`);
    process.exit(0);
  }

  const byId = new Map(plans.map((plan) => [plan.gate.id, plan]));
  if (argument !== 'all' && !byId.has(argument)) {
    process.stderr.write(`unknown gate "${argument}"; run "npm run gate -- list"\n`);
    process.exit(2);
  }

  if (argument === 'all' && unclaimed.length > 0) {
    for (const file of unclaimed) process.stderr.write(`unassigned test: ${file}\n`);
    process.stderr.write('refusing to run a partial gate set\n');
    process.exit(1);
  }

  const selected = argument === 'all' ? plans : [byId.get(argument) as GatePlan];

  let failed = 0;
  for (const plan of selected) {
    if (!runPlan(plan)) failed += 1;
  }

  process.stdout.write(
    `\n${failed === 0 ? 'gates passed' : `gates failed: ${failed}`} ` +
      `(${selected.length} selected)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`quality gate error: ${(error as Error).message}\n`);
  process.exit(1);
}
