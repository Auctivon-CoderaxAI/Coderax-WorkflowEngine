/**
 * Stable client-side failures.
 *
 * `CoderaxApiError` is a Problem the engine returned. `CoderaxContractError` is
 * a payload that did not match the published schema. `CoderaxCompatibilityError`
 * is a version handshake that cannot be satisfied. The three are distinct
 * because a caller retries the first, reports the second and refuses to start on
 * the third.
 */
export class CoderaxApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = 'CoderaxApiError';
    this.code = input.code;
    this.status = input.status;
    this.requestId = input.requestId;
    this.retryable = input.retryable ?? false;
  }
}

export class CoderaxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoderaxContractError';
  }
}

export class CoderaxCompatibilityError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the engine is not compatible with this SDK: ${problems.join('; ')}`);
    this.name = 'CoderaxCompatibilityError';
    this.problems = [...problems];
  }
}
