/**
 * Raised only when a memory value breaks the configured bound.
 *
 * The stores throw this instead of a bare `Error` so the service can answer a
 * value that is genuinely too large with `validation_failed` and let every other
 * failure, such as an unavailable database, propagate as what it is.
 */
export class MemoryValueTooLargeError extends Error {
  readonly maxValueLength: number;

  constructor(maxValueLength: number) {
    super(`memory value exceeds the configured bound of ${maxValueLength} characters`);
    this.name = 'MemoryValueTooLargeError';
    this.maxValueLength = maxValueLength;
  }
}
