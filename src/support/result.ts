import type { ProblemCode } from '@coderax/contracts';

export type ServiceFailure = {
  ok: false;
  code: ProblemCode;
  /** User-safe text: no stack, path, query or credential. */
  detail: string;
  retryable: boolean;
};

export type ServiceSuccess<T> = { ok: true; value: T };

export type ServiceResult<T> = ServiceSuccess<T> | ServiceFailure;

export function fail(
  code: ProblemCode,
  detail: string,
  retryable = false,
): ServiceFailure {
  return { ok: false, code, detail, retryable };
}

export function ok<T>(value: T): ServiceSuccess<T> {
  return { ok: true, value };
}
