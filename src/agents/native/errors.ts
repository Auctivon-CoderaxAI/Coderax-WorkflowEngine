import type { EngineFailureCode } from '@coderax/contracts';
import type { StepActionFailure } from './types.js';

/**
 * A failed attempt is classified before it is retried. A provider failure and an
 * empty answer are recoverable within a bound; a denied read, a missing resource
 * or an unsupported action is not. Retrying a permanent failure would only spend
 * the owner's zero-cost budget without changing the outcome.
 */
export type CorrectionDecision = 'retry' | 'correct' | 'fail';

export function decideCorrection(input: {
  failure: StepActionFailure;
  attempts: number;
  maxAttempts: number;
}): CorrectionDecision {
  if (input.attempts >= input.maxAttempts) return 'fail';
  if (input.failure.code === 'provider_error' && input.failure.retryable) return 'retry';
  if (input.failure.code === 'invalid_output') return 'correct';
  return 'fail';
}

export function toFailureCode(failure: StepActionFailure): EngineFailureCode {
  switch (failure.code) {
    case 'workspace_denied':
    case 'not_found':
      return 'workspace_denied';
    case 'provider_error':
    case 'invalid_output':
      return 'provider_error';
    case 'too_large':
    case 'unsupported':
      return 'protocol_error';
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener('abort', finish, { once: true });
  });
}
