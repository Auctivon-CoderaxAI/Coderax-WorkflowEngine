import type { AgentAdapter } from '../agents/types.js';

/**
 * A durable schedule runs while nobody is watching.
 *
 * An adapter whose side effects are not gated by a scoped owner decision would
 * let a recurrence purchase, deploy, message or modify an account autonomously.
 * Setting `requireApproval` on the task is not enough when the adapter never
 * consults the permission store, so such an adapter is refused at creation and
 * again at dispatch. `gated` adapters are allowed because their every action
 * already stops at the permission store.
 */
export function scheduleSideEffectRefusal(
  sideEffects: AgentAdapter['sideEffects'],
): string | null {
  return sideEffects === 'ungated'
    ? 'A schedule cannot target an agent whose side effects are not gated by owner approval; submit a one-off task instead.'
    : null;
}
