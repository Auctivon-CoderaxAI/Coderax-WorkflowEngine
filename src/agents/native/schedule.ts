import type { TaskPlanStep } from '../../domain.js';

/**
 * A plan becomes execution order only here. Dependencies are checked against
 * completed work, independent steps are grouped into a wave, and a missing or
 * cyclic dependency is refused instead of being treated as ready.
 */
export type ScheduleResult =
  | { ok: true; waves: TaskPlanStep[][] }
  | { ok: false; reason: string };

export function planWaves(input: {
  steps: TaskPlanStep[];
  completed: ReadonlySet<string>;
  maxParallel: number;
}): ScheduleResult {
  const maxParallel = Math.max(1, Math.trunc(input.maxParallel));
  const done = new Set(input.completed);
  const remaining = new Map(
    input.steps.filter((step) => !done.has(step.id)).map((step) => [step.id, step]),
  );
  const waves: TaskPlanStep[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((step) =>
      step.dependsOn.every((dependency) => done.has(dependency)),
    );
    if (ready.length === 0) {
      return {
        ok: false,
        reason:
          'The plan has no ready step: a dependency is missing, or the dependencies contain a cycle.',
      };
    }
    // A dependent step is never placed in the same wave as its dependency, even
    // when the dependency is in this ready set; `done` is updated after the wave.
    const wave = ready.slice(0, maxParallel);
    for (const step of wave) remaining.delete(step.id);
    waves.push(wave);
    for (const step of wave) done.add(step.id);
  }

  return { ok: true, waves };
}

/** Number of steps that could run once the completed set is applied. */
export function remainingSteps(
  steps: TaskPlanStep[],
  completed: ReadonlySet<string>,
): TaskPlanStep[] {
  return steps.filter((step) => !completed.has(step.id));
}
