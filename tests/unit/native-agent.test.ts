import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createNativeAgent } from '../../src/agents/native/agent.js';
import type { GatewayCompletion, GatewayRequest, ModelGateway } from '../../src/agents/native/types.js';
import type {
  AgentReportEvent,
  AgentRunRequest,
  ExecutedToolAction,
} from '../../src/agents/types.js';
import { createToolRuntime } from '../../src/tools/runtime.js';
import { createHash } from 'node:crypto';

/** The simple answer shape these tests care about, wrapped into a router reply. */
type Answer = {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCall?: { name: string; arguments: Record<string, unknown> };
};

/**
 * A gateway that answers from a closure. The router port returns a completion
 * envelope, so the tests state only what they care about and this fills the rest
 * with the model the request resolved to.
 */
function gatewayOf(
  handler: (input: GatewayRequest) => Answer | Promise<Answer>,
  nativeTools = false,
): ModelGateway {
  return {
    id: 'g',
    ...(nativeTools ? { supportsNativeTools: true } : {}),
    complete: async (input): Promise<GatewayCompletion> => {
      const answer = await handler(input);
      return {
        text: answer.text,
        ...(answer.usage ? { usage: answer.usage } : {}),
        toolCalls: answer.toolCall
          ? [{ id: `call-${answer.toolCall.name}`, name: answer.toolCall.name, arguments: answer.toolCall.arguments }]
          : [],
        model: input.model,
        attempts: [input.model],
        latencyMs: 1,
      };
    },
  };
}

function runtime(onCall: () => void) {
  return createToolRuntime({
    tools: [
      {
        name: 'echo',
        description: 'Echo the text.',
        source: 'builtin',
        scopes: [],
        approval: 'never',
        parameters: { text: 'string' },
        schema: z.object({ text: z.string() }).strict(),
        resource: (input) => (input as { text: string }).text,
        run: async (input) => {
          onCall();
          return { ok: true, output: `echo:${(input as { text: string }).text}` };
        },
      },
    ],
  });
}

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    ownerId: 'owner',
    tenantId: null,
    conversationId: 'conv',
    objective: 'Do the work',
    model: { providerId: 'free', modelId: 'fast' },
    routing: 'auto',
    allowFallback: true,
    mode: 'cloud',
    operation: 'work',
    workspaceRoot: '/tmp',
    maxSteps: 8,
    budget: null,
    signal: new AbortController().signal,
    context: {},
    ...overrides,
  };
}

test('a step whose dependency has not completed is blocked, not run out of order', async () => {
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf(() => ({ text: '{"final":"first"}' })),
  });
  const events: AgentReportEvent[] = [];
  const result = await agent.run(
    request({
      context: {
        plannedSteps: [
          { id: 'step-2', title: 'Second', dependsOn: ['step-1'] },
          { id: 'step-1', title: 'First', dependsOn: [] },
        ],
      },
    }),
    (event) => events.push(event),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'verification_failed');
  assert.ok(events.some((event) => event.type === 'step.blocked' && event.stepId === 'step-2'));
  assert.equal(events.some((event) => event.type === 'step.started' && event.stepId === 'step-2'), false);
});

test('a call with an unknown effect is never replayed when approved', async () => {
  let runs = 0;
  const digest = createHash('sha256').update(JSON.stringify(['echo', { text: 'x' }])).digest('hex').slice(0, 32);
  const executed: ExecutedToolAction[] = [
    {
      stepId: 'step-1',
      digest,
      tool: 'echo',
      callId: 'call-old',
      state: 'dispatched',
      ok: false,
      output: '',
    },
  ];
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf(() => ({ text: '{"tool":"echo","input":{"text":"x"}}' })),
  });
  const result = await agent.run(
    request({
      context: {
        plannedSteps: [{ id: 'step-1', title: 'One', dependsOn: [] }],
        executionState: { observations: {}, executed },
        pendingAction: {
          stepId: 'step-1',
          json: '{"tool":"echo","input":{"text":"x"}}',
          callId: 'call-old',
        },
        tools: { runtime: runtime(() => { runs += 1; }), gate: { ensure: async () => ({ decision: 'granted' }) } },
      },
    }),
    () => undefined,
  );
  assert.equal(runs, 0);
  // The step is reported from recorded evidence, never with a fabricated result.
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.summary : '', /effect is unknown/);
});

test('a native tool call and a JSON action use the same validated execution path', async () => {
  let runs = 0;
  const requests: GatewayRequest[] = [];
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf((input) => {
      requests.push(input);
      if (requests.length === 1) {
        return {
          text: '',
          usage: { inputTokens: 3, outputTokens: 2 },
          toolCall: { name: 'echo', arguments: { text: 'hi' } },
        };
      }
      return { text: '{"final":"verified by the tool"}', usage: { inputTokens: 2, outputTokens: 2 } };
    }, true),
  });
  const events: AgentReportEvent[] = [];
  const result = await agent.run(
    request({
      context: {
        nativeTools: true,
        plannedSteps: [{ id: 'step-1', title: 'One', dependsOn: [] }],
        tools: { runtime: runtime(() => { runs += 1; }), gate: { ensure: async () => ({ decision: 'granted' }) } },
      },
    }),
    (event) => events.push(event),
  );
  assert.equal(result.ok, true);
  assert.match(result.ok ? result.summary : '', /verified by the tool/);
  assert.equal(result.ok && result.requests, 2);
  assert.equal(runs, 1);
  assert.ok(requests[0]?.tools?.some((tool) => tool.name === 'echo'));
  assert.ok(events.some((event) => event.type === 'tool.call' && event.tool === 'echo'));
});

test('a later step is prompted with the earlier step result', async () => {
  const prompts: string[] = [];
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf((input) => {
      prompts.push(input.prompt);
      return input.prompt.includes('Current step (step-1)')
        ? { text: '{"final":"EXTRACTED-VALUE"}' }
        : { text: '{"final":"used the extraction"}' };
    }),
  });
  const result = await agent.run(
    request({
      context: {
        plannedSteps: [
          { id: 'step-1', title: 'Extract', dependsOn: [] },
          { id: 'step-2', title: 'Use', dependsOn: ['step-1'] },
        ],
      },
    }),
    () => undefined,
  );
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? '', /EXTRACTED-VALUE/);
  assert.match(prompts[1] ?? '', /Results of completed steps/);
});

test('native tools are only requested from a gateway that supports them', async () => {
  const requests: GatewayRequest[] = [];
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf((input) => {
      requests.push(input);
      return { text: '{"final":"json only"}' };
    }),
  });
  let runs = 0;
  const result = await agent.run(
    request({
      context: {
        nativeTools: true,
        plannedSteps: [{ id: 'step-1', title: 'One', dependsOn: [] }],
        tools: { runtime: runtime(() => { runs += 1; }), gate: { ensure: async () => ({ decision: 'granted' }) } },
      },
    }),
    () => undefined,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.summary, 'json only');
  assert.equal(requests[0]?.tools, undefined);
  assert.equal(runs, 0);
});

test('an empty final is a protocol error, not a completed objective', async () => {
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf(() => ({ text: '{"final":"   "}' })),
  });
  const result = await agent.run(
    request({
      context: {
        plannedSteps: [{ id: 'step-1', title: 'One', dependsOn: [] }],
        tools: { runtime: runtime(() => undefined), gate: { ensure: async () => ({ decision: 'granted' }) } },
      },
    }),
    () => undefined,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'protocol_error');
});

test('a repeated action and the run ceiling stop the loop instead of spinning', async () => {
  let runs = 0;
  const agent = createNativeAgent({
    enabled: true,
    gateway: gatewayOf(() => ({ text: '{"tool":"echo","input":{"text":"x"}}' })),
  });
  const result = await agent.run(
    request({
      context: {
        maxActionsPerRun: 2,
        plannedSteps: [{ id: 'step-1', title: 'One', dependsOn: [] }],
        tools: { runtime: runtime(() => { runs += 1; }), gate: { ensure: async () => ({ decision: 'granted' }) } },
      },
    }),
    () => undefined,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'budget_exhausted');
  assert.equal(runs, 1);
});
