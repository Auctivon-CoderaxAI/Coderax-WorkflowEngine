import type { Clock } from '../support/clock.js';
import { redactText } from './redact.js';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/**
 * A JSON-line logger with a bounded, redacted field set.
 *
 * It deliberately accepts fields rather than a free-form message so a caller
 * cannot accidentally put an objective, a prompt or a token in a log line. Every
 * string passes through `redactText`, and every value is bounded, so an adapter's
 * pathological error cannot flood the log or leak a credential.
 */
export type Logger = {
  info: (event: string, fields?: LogFields) => void;
  warn: (event: string, fields?: LogFields) => void;
  error: (event: string, fields?: LogFields) => void;
};

function safeFields(fields: LogFields | undefined): LogFields {
  if (!fields) return {};
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = redactText(value, [], 500);
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      out[key] = value;
    } else {
      out[key] = '[omitted]';
    }
  }
  return out;
}

export function createJsonLogger(input: {
  clock: Clock;
  write: (line: string) => void;
}): Logger {
  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    const line = JSON.stringify({
      ts: input.clock.iso(),
      level,
      event,
      ...safeFields(fields),
    });
    input.write(`${line}\n`);
  }

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
