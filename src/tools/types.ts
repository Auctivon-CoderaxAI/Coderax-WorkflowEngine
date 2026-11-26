import type { ZodTypeAny } from 'zod';
import type {
  AgentId,
  DataMode,
  PermissionScope,
  ToolDescriptor,
  ToolSource,
} from '@coderax/contracts';
import type { ToolExecutionGuard } from '../execution/guard.js';

/**
 * A tool is data plus one function. It never owns authorization: the runtime
 * asks the approval gate before `run`, and the gate is backed by the task's
 * durable permission store. A tool declares the exact resource it needs so an
 * approval cannot be widened by a later call.
 */

export type ToolContext = {
  ownerId: string;
  taskId: string | null;
  agent: AgentId;
  mode: DataMode;
  /** The only directory the tool may touch. */
  workspaceRoot: string;
  signal: AbortSignal;
  callId: string;
  /** Supplied by the supervisor for every Chat and Work tool call. */
  guard?: ToolExecutionGuard;
};

export type ToolFailureCode =
  | 'permission_required'
  | 'approval_required'
  | 'not_found'
  | 'validation_failed'
  | 'tool_failed'
  | 'cancelled';

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; code: ToolFailureCode; detail: string };

export type Tool = {
  name: string;
  description: string;
  source: ToolSource;
  scopes: PermissionScope[];
  approval: 'never' | 'once' | 'always';
  /** True when the tool can create a process the engine cannot reap. */
  spawnsProcesses?: boolean;
  parameters: Record<string, string>;
  schema: ZodTypeAny;
  /** Exact resource named to the owner; never derived from a grant. */
  resource: (input: unknown, context: ToolContext) => string;
  run: (input: unknown, context: ToolContext) => Promise<ToolResult>;
};

export type ApprovalDecision = 'granted' | 'pending' | 'denied';

export type ApprovalGate = {
  ensure: (input: {
    scope: PermissionScope;
    resource: string;
    description: string;
    tool: string;
    binding: string;
    consume: boolean;
  }) => Promise<{ decision: ApprovalDecision; requestId?: string }>;
};

export type ToolCallOutcome = {
  result: ToolResult;
  approval: 'not_required' | 'granted' | 'pending' | 'denied';
  /** The durable request the owner must decide; present only while pending. */
  requestId?: string;
};

export type ToolRuntime = {
  list: () => ToolDescriptor[];
  get: (name: string) => Tool | null;
  call: (input: {
    name: string;
    arguments: unknown;
    context: ToolContext;
    gate: ApprovalGate;
  }) => Promise<ToolCallOutcome>;
  /** A bounded catalogue rendered for the model's action prompt. */
  catalogue: () => string;
};

export function describeTool(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    source: tool.source,
    scopes: [...tool.scopes],
    approval: tool.approval,
    parameters: { ...tool.parameters },
  };
}

export function failure(code: ToolFailureCode, detail: string): ToolResult {
  return { ok: false, code, detail };
}

export function success(output: string): ToolResult {
  return { ok: true, output };
}

export function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}
