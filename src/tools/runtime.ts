import { createHash } from 'node:crypto';
import type { ToolDescriptor } from '@coderax/contracts';
import type {
  ApprovalGate,
  Tool,
  ToolCallOutcome,
  ToolRuntime,
  ToolSchema,
} from './types.js';
import { redactToolInput } from '../observability/redact.js';
import { bounded, describeTool, failure, parametersToJsonSchema } from './types.js';

/**
 * The single execution path for every tool, regardless of whether it is a
 * built-in, an MCP server or a plugin. Input is validated against the tool's own
 * schema, every declared scope is approved against the exact resource, and only
 * then does the tool run. A pending approval is reported as a suspension, not as
 * a denial: the task can be resumed after the owner decides.
 *
 * An approval is bound to the tool, the data mode, the exact validated arguments
 * and the declared policy. `once` and `always` both consume exactly one owner
 * decision per invocation, so a browser or computer-use action cannot ride on an
 * earlier grant for a different call.
 */

function validationDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'issues' in error) {
    const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
      .issues;
    const first = issues?.[0];
    if (first) {
      const where = first.path && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
      return bounded(`Invalid tool input — ${where}${first.message ?? 'invalid value'}`, 300);
    }
  }
  return 'Invalid tool input.';
}

// Use the same secret scrubber as tool events. Describe bulk payloads by size
// so approvals do not copy document bodies into the permission store.
function approvalPreview(input: unknown): string {
  const summary = JSON.stringify(redactToolInput(input), (key, value: unknown) => {
    if (value === '[redacted]') return value;
    if (/^(?:body|content|text|value|data|payload|headers)$/i.test(key)) return '[payload omitted]';
    if (typeof value !== 'string') return value;
    // An MCP schema can use arbitrary names for private content. Only show
    // string values for fields that identify the operation or its target.
    if (!/^(?:action|operation|method|destination|target|recipient|path|command|url)$/i.test(key)) {
      return `[${value.length} characters]`;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try { return new URL(value).origin; } catch { return '[invalid URL]'; }
    }
    return bounded(value, 160);
  });
  return bounded(summary ?? '{}', 1400);
}

function bindingOf(tool: Tool, policy: string, mode: string, input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tool.name, policy, mode, input]))
    .digest('hex');
}

export function createToolRuntime(input: {
  tools: Tool[];
  /** Aggregate catalogue bound; the action prompt must stay inside the model budget. */
  catalogueMaxChars?: number;
}): ToolRuntime {
  const byName = new Map<string, Tool>();
  for (const tool of input.tools) {
    // A duplicate name would make execution depend on registration order.
    if (byName.has(tool.name)) continue;
    byName.set(tool.name, tool);
  }
  const tools = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  const catalogueMaxChars = input.catalogueMaxChars ?? 12_000;

  async function call(request: {
    name: string;
    arguments: unknown;
    context: Parameters<ToolRuntime['call']>[0]['context'];
    gate: ApprovalGate;
    policy?: 'never' | 'once' | 'always';
    approvalRequestId?: string;
  }): Promise<ToolCallOutcome> {
    const tool = byName.get(request.name);
    if (!tool) {
      return { result: failure('not_found', 'That tool is not registered.'), approval: 'not_required' };
    }
    if (request.context.signal.aborted) {
      return { result: failure('cancelled', 'The run was cancelled.'), approval: 'not_required' };
    }

    const parsed = tool.schema.safeParse(request.arguments ?? {});
    if (!parsed.success) {
      return {
        result: failure('validation_failed', validationDetail(parsed.error)),
        approval: 'not_required',
      };
    }

    let approval: ToolCallOutcome['approval'] = 'not_required';
    if (tool.approval !== 'never') {
      const policy = tool.approval;
      const resource = bounded(String(tool.resource(parsed.data, request.context)), 1024);
      const binding = bindingOf(tool, policy, request.context.mode, parsed.data);
      for (const scope of tool.scopes) {
        let decision;
        try {
          decision = await request.gate.ensure({
            scope,
            resource,
            description: `Arguments: ${approvalPreview(parsed.data)}. ${tool.description}`,
            tool: tool.name,
            binding,
            callId: request.context.callId,
            ...(request.approvalRequestId ? { requestId: request.approvalRequestId } : {}),
            policy,
            consume: true,
          });
        } catch {
          // A permission-store fault is a transient dependency failure, not a
          // permanent provider error: say which check failed and let the run be
          // retried instead of mislabelling it.
          return {
            result: failure(
              'approval_unavailable',
              'The approval check failed; the action was not executed.',
            ),
            approval: 'denied',
          };
        }
        if (decision.decision === 'pending') {
          return {
            result: failure(
              'approval_required',
              `Owner approval is required before ${tool.name} may use ${resource}.`,
            ),
            approval: 'pending',
            ...(decision.requestId ? { requestId: decision.requestId } : {}),
          };
        }
        if (decision.decision === 'denied') {
          return {
            result: failure(
              'permission_required',
              `The owner did not grant ${scope} for ${resource}.`,
            ),
            approval: 'denied',
          };
        }
        approval = 'granted';
      }
    }

    // The gate is asynchronous; a cancellation that landed while it waited must
    // stop the dispatch, not be discovered by the tool's first write.
    if (request.context.signal.aborted) {
      return { result: failure('cancelled', 'The run was cancelled.'), approval };
    }

    try {
      const result = await tool.run(parsed.data, request.context);
      return { result, approval };
    } catch {
      // A tool's own exception text can contain a path, a command or a provider
      // payload, so only a stable message crosses this boundary.
      return { result: failure('tool_failed', 'The tool failed while executing.'), approval };
    }
  }

  function catalogue(): string {
    const lines: string[] = [];
    let used = 0;
    for (const tool of tools) {
      const parameters = Object.entries(tool.parameters)
        .map(([name, type]) => `${name}: ${type}`)
        .join(', ');
      const gate = tool.approval === 'never' ? '' : ' [needs owner approval]';
      const line = `- ${tool.name}(${parameters}) — ${tool.description}${gate}`;
      if (used + line.length + 1 > catalogueMaxChars) {
        lines.push('- (additional tools omitted to keep the prompt within the model budget)');
        break;
      }
      used += line.length + 1;
      lines.push(line);
    }
    return lines.join('\n');
  }

  return {
    list: (): ToolDescriptor[] => tools.map(describeTool),
    get: (name) => byName.get(name) ?? null,
    schemas: (): ToolSchema[] =>
      tools.map((tool) => ({
        name: tool.name,
        description: bounded(tool.description, 600),
        parameters: tool.inputSchema ?? parametersToJsonSchema(tool.parameters),
      })),
    call,
    catalogue,
  };
}
