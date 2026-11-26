import { createHash } from 'node:crypto';
import type { ToolDescriptor } from '@coderax/contracts';
import type {
  ApprovalGate,
  Tool,
  ToolCallOutcome,
  ToolRuntime,
} from './types.js';
import { bounded, describeTool, failure } from './types.js';

/**
 * The single execution path for every tool, regardless of whether it is a
 * built-in, an MCP server or a plugin. Input is validated against the tool's own
 * schema, every declared scope is approved against the exact resource, and only
 * then does the tool run. A pending approval is reported as a suspension, not as
 * a denial: the task can be resumed after the owner decides.
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

export function createToolRuntime(input: { tools: Tool[] }): ToolRuntime {
  const byName = new Map<string, Tool>();
  for (const tool of input.tools) {
    // A duplicate name would make execution depend on registration order.
    if (byName.has(tool.name)) continue;
    byName.set(tool.name, tool);
  }
  const tools = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));

  async function call(request: {
    name: string;
    arguments: unknown;
    context: Parameters<ToolRuntime['call']>[0]['context'];
    gate: ApprovalGate;
  }): Promise<ToolCallOutcome> {
    const tool = byName.get(request.name);
    if (!tool) {
      return { result: failure('not_found', 'That tool is not registered.'), approval: 'not_required' };
    }
    if (request.context.signal.aborted) {
      return { result: failure('cancelled', 'The run was cancelled.'), approval: 'not_required' };
    }
    // The supervisor's guard is the authority gate that survives an adapter
    // ignoring its abort: once the execution is revoked, no tool call starts.
    const guard = request.context.guard;
    if (guard && !guard.live()) {
      return {
        result: failure('cancelled', 'The execution is no longer authorized.'),
        approval: 'not_required',
      };
    }

    const parsed = tool.schema.safeParse(request.arguments ?? {});
    if (!parsed.success) {
      return {
        result: failure('validation_failed', validationDetail(parsed.error)),
        approval: 'not_required',
      };
    }

    const resource = bounded(String(tool.resource(parsed.data, request.context)), 1024);
    if (guard) {
      for (const scope of tool.scopes) {
        if (!guard.permits(scope, resource)) {
          return {
            result: failure(
              'permission_required',
              `The execution is not authorized for ${scope} on ${resource}.`,
            ),
            approval: 'not_required',
          };
        }
      }
    }

    let approval: ToolCallOutcome['approval'] = 'not_required';
    if (tool.approval !== 'never') {
      for (const scope of tool.scopes) {
        const decision = await request.gate.ensure({
          scope,
          resource,
          description: tool.description,
          tool: tool.name,
          binding: createHash('sha256').update(JSON.stringify([tool.name, request.context.mode, parsed.data])).digest('hex'),
          consume: true,
        });
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

    if (guard) {
      for (const scope of tool.scopes) {
        guard.recordUse({ scope, resource, spawnsProcesses: tool.spawnsProcesses === true });
      }
    }
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

  return {
    list: (): ToolDescriptor[] => tools.map(describeTool),
    get: (name) => byName.get(name) ?? null,
    call,
    catalogue: () =>
      tools
        .map((tool) => {
          const parameters = Object.entries(tool.parameters)
            .map(([name, type]) => `${name}: ${type}`)
            .join(', ');
          const gate = tool.approval === 'never' ? '' : ' [needs owner approval]';
          return `- ${tool.name}(${parameters}) — ${tool.description}${gate}`;
        })
        .join('\n'),
  };
}
