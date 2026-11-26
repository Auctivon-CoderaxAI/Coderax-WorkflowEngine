import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createNativeAgent } from '../../src/agents/native/agent.js';
import { ToolCallingUnsupportedError } from '../../src/agents/native/gateway.js';
import type {
  AgentReportEvent,
  AgentRunRequest,
  ExecutedToolAction,
} from '../../src/agents/types.js';
import type { ModelCompletionRequest, ModelGateway } from '../../src/agents/native/types.js';
import { createToolRuntime } from '../../src/tools/runtime.js';
import { createHash } from 'node:crypto';

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
    mode: 'cloud',
    workspaceRoot: '/tmp',
    maxSteps: 8,
    budget: null,
    signal: new AbortController().signal,
    context: {},
    ...overrides,
  };
}

test('a step whose dependency has not completed is blocked, not run out of order', async () => {
  const agent = createNativeAgent({ enabled: true, gateway: { id: 'g', complete: async () => ({ text: '{"final":"first"}' }) } });
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
  const gateway: ModelGateway = {
    id: 'g',
    complete: async () => ({ text: '{"tool":"echo","input":{"text":"x"}}' }),
  };
  const agent = createNativeAgent({ enabled: true, gateway });
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
  const requests: ModelCompletionRequest[] = [];
  const gateway: ModelGateway = {
    id: 'native',
    supportsNativeTools: true,
    complete: async (input) => {
      requests.push(input);
      if (requests.length === 1) {
        return { text: '', usage: { inputTokens: 3, outputTokens: 2 }, toolCall: { name: 'echo', arguments: { text: 'hi' } } };
      }
      return { text: '{"final":"verified by the tool"}', usage: { inputTokens: 2, outputTokens: 2 } };
    },
  };
  const agent = createNativeAgent({ enabled: true, gateway });
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
  const gateway: ModelGateway = {
    id: 'g',
    complete: async (input) => {
      prompts.push(input.prompt);
      return input.prompt.includes('Current step (step-1)')
        ? { text: '{"final":"EXTRACTED-VALUE"}' }
        : { text: '{"final":"used the extraction"}' };
    },
  };
  const agent = createNativeAgent({ enabled: true, gateway });
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

test('a provider that refuses tool definitions falls back to the JSON action protocol', async () => {
  let runs = 0;
  const requests: ModelCompletionRequest[] = [];
  const gateway: ModelGateway = {
    id: 'json-only',
    supportsNativeTools: true,
    complete: async (input) => {
      requests.push(input);
      if (requests.length === 1) throw new ToolCallingUnsupportedError();
      return { text: '{"final":"json mode"}' };
    },
  };
  const agent = createNativeAgent({ enabled: true, gateway });
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
  assert.match(result.ok ? result.summary : '', /json mode/);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]?.tools !== undefined);
  assert.equal(requests[1]?.tools, undefined);
  assert.equal(runs, 0);
});

test('an empty final is a protocol error, not a completed objective', async () => {
  const agent = createNativeAgent({
    enabled: true,
    gateway: { id: 'g', complete: async () => ({ text: '{"final":"   "}' }) },
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
    gateway: { id: 'g', complete: async () => ({ text: '{"tool":"echo","input":{"text":"x"}}' }) },
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
