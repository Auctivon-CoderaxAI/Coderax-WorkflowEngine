import type { EngineId } from '@coderax/contracts';
import type { ServiceFailure } from '../support/result.js';
import { fail } from '../support/result.js';

/**
 * One logical task may be executed by at most one engine. Without this, a
 * fallback path could start a second engine while the first is still editing the
 * same workspace, producing duplicate or conflicting changes. Selection itself
 * never falls back; this guards the remaining case where a caller retries.
 */
export class EngineRunArbiter {
  private readonly owners = new Map<string, EngineId>();

  acquire(taskKey: string, engine: EngineId): { ok: true } | ServiceFailure {
    if (!taskKey) {
      return fail('protocol_error', 'A task key is required.');
    }
    const current = this.owners.get(taskKey);
    if (current) {
      return fail(
        'busy',
        current === engine
          ? 'This task is already running on this engine.'
          : 'This task is already running on another engine.',
      );
    }
    this.owners.set(taskKey, engine);
    return { ok: true };
  }

  release(taskKey: string, engine: EngineId): void {
    if (this.owners.get(taskKey) === engine) {
      this.owners.delete(taskKey);
    }
  }

  owner(taskKey: string): EngineId | null {
    return this.owners.get(taskKey) ?? null;
  }

  /** Test and shutdown support; never called by a request path. */
  clear(): void {
    this.owners.clear();
  }
}
