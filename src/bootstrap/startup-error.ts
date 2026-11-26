/**
 * A startup failure lists every blocking issue it found.
 *
 * It is its own module because both the composition root and the persistence
 * builder throw it; importing it from the composition root would create a cycle
 * between wiring and the store it wires.
 */
export class StartupError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`The engine cannot start (${issues.length} blocking issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'StartupError';
    this.issues = issues;
  }
}
