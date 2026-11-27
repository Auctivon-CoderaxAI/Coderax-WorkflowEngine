import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ActionExecution, ActionExecutor, ModelGateway } from './types.js';
import { buildStepPrompt, STEP_SYSTEM } from './prompt.js';

/**
 * Native's action layer. A `reason` step is a model completion; a `read` step is
 * one confined, read-only workspace read. There is no write, command or network
 * action, so a plan that requests one is rejected by the planner rather than
 * reported as done.
 */

const MAX_READ_BYTES = 64_000;

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(candidate: string, parent: string): boolean {
  const left = normalize(candidate);
  const right = normalize(parent);
  return left === right || left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

export type WorkspaceRead =
  | { ok: true; text: string; citation: string }
  | {
      ok: false;
      code: 'workspace_denied' | 'not_found' | 'too_large' | 'unsupported';
      detail: string;
    };

/**
 * Resolves both the root and the target through symlinks before comparing them,
 * so a link inside the workspace cannot read the host or the other data mode.
 */
export async function readWorkspaceFile(input: {
  root: string;
  resource: string;
  maxBytes?: number;
}): Promise<WorkspaceRead> {
  let root: string;
  try {
    root = await realpath(input.root);
  } catch {
    return { ok: false, code: 'workspace_denied', detail: 'The workspace root is unavailable.' };
  }

  let target: string;
  try {
    target = await realpath(path.resolve(root, input.resource));
  } catch {
    return { ok: false, code: 'not_found', detail: 'That workspace file does not exist.' };
  }
  if (!isInside(target, root)) {
    return { ok: false, code: 'workspace_denied', detail: 'That path is outside the workspace.' };
  }

  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      return { ok: false, code: 'unsupported', detail: 'That workspace entry is not a regular file.' };
    }
    size = info.size;
  } catch {
    return { ok: false, code: 'not_found', detail: 'That workspace file could not be inspected.' };
  }
  const maxBytes = input.maxBytes ?? MAX_READ_BYTES;
  if (size > maxBytes) {
    return { ok: false, code: 'too_large', detail: 'That workspace file exceeds the read bound.' };
  }

  let buffer: Buffer;
  try {
    const handle = await open(target, 'r');
    try {
      // The file can grow after `stat`; read at most one byte past the bound so
      // an append cannot turn this into an unbounded allocation.
      const scratch = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < scratch.length) {
        const { bytesRead } = await handle.read(
          scratch,
          offset,
          scratch.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) {
        return { ok: false, code: 'too_large', detail: 'That workspace file exceeds the read bound.' };
      }
      buffer = scratch.subarray(0, offset);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return { ok: false, code: 'not_found', detail: 'That workspace file could not be read.' };
  }
  if (buffer.includes(0)) {
    return { ok: false, code: 'unsupported', detail: 'Binary workspace files are not read as text.' };
  }
  const digest = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  return {
    ok: true,
    text: `File ${input.resource} (${buffer.byteLength} bytes, sha256 ${digest}):\n\n${text}`,
    citation: `read ${input.resource} (${buffer.byteLength} bytes, sha256 ${digest})`,
  };
}

export function createNativeExecutor(gateway: ModelGateway): ActionExecutor {
  return {
    execute: async (input): Promise<ActionExecution> => {
      if (input.signal.aborted) {
        return {
          ok: false,
          failure: { code: 'provider_error', detail: 'The run was cancelled.', retryable: false },
        };
      }

      if (input.step.kind === 'read') {
        if (!input.step.resource) {
          return {
            ok: false,
            failure: {
              code: 'workspace_denied',
              detail: 'The read step did not name a workspace resource.',
              retryable: false,
            },
          };
        }
        const read = await readWorkspaceFile({
          root: input.workspaceRoot,
          resource: input.step.resource,
        });
        if (!read.ok) {
          return {
            ok: false,
            failure: { code: read.code, detail: read.detail, retryable: false },
          };
        }
        return { ok: true, text: read.text, citation: read.citation };
      }

      try {
        const completion = await gateway.complete({
          model: input.model,
          system: STEP_SYSTEM,
          prompt: buildStepPrompt({
            objective: input.objective,
            step: input.step,
            mode: input.mode,
            history: input.history,
            evidence: input.evidence,
            completed: new Set(input.evidence.map((entry) => entry.stepId)),
            ...(input.feedback ? { feedback: input.feedback } : {}),
          }),
          signal: input.signal,
          ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        });
        const text = completion.text.trim();
        if (text.length === 0) {
          return {
            ok: false,
            failure: {
              code: 'invalid_output',
              detail: 'The model returned an empty step result.',
              retryable: false,
            },
          };
        }
        return {
          ok: true,
          text,
          ...(completion.usage ? { usage: completion.usage } : {}),
        };
      } catch {
        return {
          ok: false,
          failure: {
            code: 'provider_error',
            detail: 'The inference endpoint failed while executing this step.',
            retryable: true,
          },
        };
      }
    },
  };
}
