import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentReportEvent, AgentRunRequest } from '../../src/agents/types.js';
import { createNativeAgent } from '../../src/agents/native/agent.js';
import { verifyObjective } from '../../src/agents/native/verify.js';
import type {
  ActionExecutor,
  ModelCompletionRequest,
  BasicModelGateway as ModelGateway,
  NativeLimits,
  ReasoningPlanner as Planner,
  ReplanInput,
} from '../../src/agents/native/types.js';
import type { TaskPlan, TaskPlanStep } from '../../src/domain.js';
import { fakeGateway } from '../helpers.js';

function step(id: string, dependsOn: string[] = [], kind: 'reason' | 'read' = 'reason'): TaskPlanStep {
  return {
    id,
    title: `Step ${id}`,
    kind,
    dependsOn,
    ...(kind === 'read' ? { resource: 'notes.txt' } : {}),
  };
}

function planOf(
  steps: TaskPlanStep[],
  mode: 'fast' | 'complex' = 'complex',
  revision = 1,
): TaskPlan {
  return { revision, mode, steps };
}

function runRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    ownerId: 'owner',
    tenantId: null,
    conversationId: 'conv',
    taskId: 'task-1',
    workload: 'work',
    game: null,
    operation: 'work', routing: 'auto', allowFallback: false,
    objective: 'Produce the result',
    model: { providerId: 'free', modelId: 'coderax-small' },
    mode: 'cloud',
    workspaceRoot: '/tmp',
    maxSteps: 8,
    budget: null,
    signal: new AbortController().signal,
    reasoning: 'complex',
    ...overrides,
  };
}

function scriptedPlanner(input: {
  plans: TaskPlan[];
  replans?: TaskPlan[];
  onReplan?: (request: ReplanInput) => void;
}): Planner {
  let planIndex = 0;
  let replanIndex = 0;
  const replans = input.replans ?? input.plans;
  return {
    plan: async () => {
      const next = input.plans[Math.min(planIndex, input.plans.length - 1)];
      planIndex += 1;
      if (!next) throw new Error('no scripted plan');
      return { plan: next };
    },
    replan: async (request) => {
      input.onReplan?.(request);
      const next = replans[Math.min(replanIndex, replans.length - 1)];
      replanIndex += 1;
      if (!next) throw new Error('no scripted revision');
      return { plan: next };
    },
  };
}

function agentWith(
  gateway: ModelGateway,
  planner?: Planner,
  limits: Partial<NativeLimits> = {},
) {
  return createNativeAgent({
    enabled: true,
    gateway,
    ...(planner ? { planner } : {}),
    limits: {
      maxSteps: 8,
      maxParallelSteps: 3,
      maxReplans: 2,
      maxStepAttempts: 1,
      maxIterations: 16,
      ...limits,
    },
  });
}

function stepGateway(options: {
  delayMs?: number;
  failStepOnce?: string;
  failAllSteps?: boolean;
  verificationPassed?: boolean;
  uncitedPass?: boolean;
  longOutput?: number;
} = {}): ModelGateway & { calls: number; maxActive: number; prompts: string[] } {
  const failed = new Set<string>();
  let active = 0;
  const gateway: ModelGateway & { calls: number; maxActive: number; prompts: string[] } = {
    id: 'step-gateway',
    calls: 0,
    maxActive: 0,
    prompts: [],
    complete: async (request: ModelCompletionRequest) => {
      gateway.calls += 1;
      gateway.prompts.push(request.prompt);
      const turn = `${request.system}\n${request.prompt}`;
      if (turn.includes('CODERAX_VERIFY_V1')) {
        const cited = [...turn.matchAll(/EVIDENCE ([A-Za-z0-9._-]+):/g)]
          .map((match) => match[1])
          .filter((id): id is string => typeof id === 'string');
        if (options.verificationPassed === false) {
          return {
            text: JSON.stringify({
              passed: false,
              reason: 'the collected evidence does not prove the objective',
              cited: [],
            }),
          };
        }
        return {
          text: JSON.stringify({
            passed: true,
            reason: 'evidence covers the objective',
            cited: options.uncitedPass ? [] : cited,
          }),
        };
      }

      const stepId = /Current step \(([^)]+)\)/.exec(request.prompt)?.[1] ?? 'chat';
      if (
        options.failAllSteps ||
        (options.failStepOnce === stepId && !failed.has(stepId))
      ) {
        failed.add(stepId);
        throw new Error('provider unavailable');
      }

      active += 1;
      gateway.maxActive = Math.max(gateway.maxActive, active);
      try {
        if (options.delayMs) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.delayMs);
            timer.unref();
          });
        }
        if (request.signal.aborted) throw new Error('aborted');
        return {
          text:
            options.longOutput !== undefined
              ? `result-${stepId}${'x'.repeat(options.longOutput)}-END`
              : `result-${stepId}`,
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      } finally {
        active -= 1;
      }
    },
  };
  return gateway;
}

test('complex plans run independent steps in parallel and dependent steps after their output', async () => {
  const gateway = stepGateway({ delayMs: 25 });
  const planner = scriptedPlanner({
    plans: [
      planOf([
        step('a'),
        step('b'),
        step('c', ['a', 'b']),
        step('d'),
      ]),
    ],
  });
  const agent = agentWith(gateway, planner, { maxParallelSteps: 2 });
  const events: AgentReportEvent[] = [];
  const outcome = await agent.run(
    runRequest({ history: [{ role: 'user', text: 'Owner context' }] }),
    (event) => events.push(event),
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.verification?.passed, true);
  // Three ready steps with a cap of two: an ignored cap would reach three.
  assert.equal(gateway.maxActive, 2, `expected the cap to hold, saw ${gateway.maxActive}`);

  const starts = events
    .filter((event): event is Extract<AgentReportEvent, { type: 'step.started' }> =>
      event.type === 'step.started',
    )
    .map((event) => event.stepId);
  assert.ok(starts.indexOf('c') > starts.indexOf('a'));
  assert.ok(starts.indexOf('c') > starts.indexOf('b'));

  const dependentPrompt = gateway.prompts.find((prompt) =>
    prompt.includes('Current step (c):'),
  );
  assert.ok(dependentPrompt);
  assert.match(dependentPrompt, /result-a/);
  assert.match(dependentPrompt, /result-b/);
  assert.match(dependentPrompt, /Earlier in this conversation:/);
  assert.match(dependentPrompt, /Owner context/);

  const verificationPrompt = gateway.prompts.find((prompt) =>
    prompt.includes('Assess only whether the evidence proves the objective.'),
  );
  assert.ok(verificationPrompt);
  assert.match(verificationPrompt, /OUTPUT a: result-a/);
  assert.match(verificationPrompt, /OUTPUT b: result-b/);
  assert.match(verificationPrompt, /OUTPUT d: result-d/);
});

test('a long step result is preserved in the summary and streamed text', async () => {
  const gateway = stepGateway({ longOutput: 5_000 });
  const agent = agentWith(gateway, scriptedPlanner({ plans: [planOf([step('long')])] }));
  const events: AgentReportEvent[] = [];
  const outcome = await agent.run(runRequest(), (event) => events.push(event));

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.summary.length > 5_000, 'the full step result must survive');
  assert.match(outcome.summary, /-END/);
  const streamed = events
    .filter(
      (event): event is Extract<AgentReportEvent, { type: 'text.delta' }> =>
        event.type === 'text.delta',
    )
    .map((event) => event.text)
    .join('');
  assert.match(streamed, /-END/);
  assert.ok(events.some((event) => event.type === 'budget' && event.iterations === 3));
});

test('an exhausted wave aborts and drains sibling actions before returning', async () => {
  let started = 0;
  let aborted = false;
  let release: () => void = () => undefined;
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: ActionExecutor = {
    execute: ({ signal }) => {
      started += 1;
      return new Promise((resolve) => {
        const stop = (): void => {
          aborted = true;
          // Stay pending after abort so the test can prove the wave waits for
          // settlement instead of returning as soon as the failure is known.
          void drained.then(() =>
            resolve({
              ok: false,
              failure: { code: 'provider_error', detail: 'aborted', retryable: false },
            }),
          );
        };
        if (signal.aborted) {
          stop();
          return;
        }
        signal.addEventListener('abort', stop, { once: true });
      });
    },
  };
  const agent = createNativeAgent({
    enabled: true,
    gateway: fakeGateway(),
    executor,
    limits: {
      maxSteps: 8,
      maxParallelSteps: 2,
      maxReplans: 0,
      maxStepAttempts: 1,
      maxIterations: 1,
    },
  });

  let settled = false;
  const run = agent
    .run(runRequest({ plan: planOf([step('a'), step('b')]) }), () => undefined)
    .then((result) => {
      settled = true;
      return result;
    });

  for (let tick = 0; tick < 50 && !aborted; tick += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(aborted, true, 'the in-flight sibling action must be aborted');
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, 'the run must wait for the aborted action to settle');

  release();
  const outcome = await run;
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'iteration_exhausted');
  assert.equal(started, 1);
});

test('a failed step triggers a bounded replan and the revision runs', async () => {
  const gateway = stepGateway({ failStepOnce: 'a' });
  const captured: { failure: ReplanInput['failure'] | null } = { failure: null };
  const planner = scriptedPlanner({
    plans: [planOf([step('a')])],
    replans: [planOf([step('b')], 'complex', 2)],
    onReplan: (request) => {
      captured.failure = request.failure;
    },
  });
  const agent = agentWith(gateway, planner, { maxReplans: 1 });
  const events: AgentReportEvent[] = [];
  const outcome = await agent.run(runRequest(), (event) => events.push(event));

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(captured.failure?.reason, 'step_failed');
  const plans = events.filter(
    (event): event is Extract<AgentReportEvent, { type: 'plan.ready' }> =>
      event.type === 'plan.ready',
  );
  assert.equal(plans.length, 2);
  assert.equal(plans[1]?.plan.revision, 2);
  assert.deepEqual(plans[1]?.plan.steps.map((entry) => entry.id), ['b']);
  assert.ok(outcome.verification?.evidence.some((entry) => entry.startsWith('b:')));
});

test('a transient provider failure is corrected within the step bound', async () => {
  const gateway = stepGateway({ failStepOnce: 'a' });
  const agent = agentWith(
    gateway,
    scriptedPlanner({ plans: [planOf([step('a')])] }),
    { maxStepAttempts: 2, maxReplans: 0 },
  );
  const events: AgentReportEvent[] = [];
  const outcome = await agent.run(runRequest(), (event) => events.push(event));

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const completed = events.find(
    (event): event is Extract<AgentReportEvent, { type: 'step.completed' }> =>
      event.type === 'step.completed',
  );
  assert.equal(completed?.attempts, 2);
  assert.equal(gateway.calls, 3);
});

test('a replan is not asked for when no step capacity remains', async () => {
  const gateway = stepGateway({ verificationPassed: false });
  let replanned = false;
  const planner = scriptedPlanner({
    plans: [planOf([step('a')])],
    replans: [planOf([step('b')])],
    onReplan: () => {
      replanned = true;
    },
  });
  const agent = agentWith(gateway, planner, { maxReplans: 1 });
  const outcome = await agent.run(
    runRequest({ maxSteps: 1 }),
    () => undefined,
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'verification_failed');
  assert.equal(replanned, false);
});

test('a blank citation row is not a citable evidence source', async () => {
  const gateway: ModelGateway = {
    id: 'test',
    complete: async () => ({
      text: JSON.stringify({ passed: true, reason: 'ok', cited: ['b'] }),
    }),
  };
  const result = await verifyObjective({
    gateway,
    model: { providerId: 'free', modelId: 'test' },
    signal: new AbortController().signal,
    objective: 'Check the result',
    mode: 'complex',
    plan: planOf([step('a')]),
    completed: new Set(['a']),
    evidence: [
      { stepId: 'a', title: 'A', attempts: 1, citation: 'a: real evidence', output: 'real' },
      { stepId: 'b', title: 'B', attempts: 1, citation: '   ', output: 'blank' },
    ],
  });
  assert.equal(result.verification.passed, false);
});

test('a verifier that passes without citing evidence is rejected', async () => {
  const gateway = stepGateway({ uncitedPass: true });
  const fixed = planOf([step('a')], 'fast');
  const agent = agentWith(gateway, scriptedPlanner({ plans: [fixed] }), { maxReplans: 0 });
  const outcome = await agent.run(
    runRequest({ reasoning: 'fast', plan: fixed }),
    () => undefined,
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'verification_failed');
  assert.match(outcome.detail, /without citing/);
});

test('a failed verification is reported as a failure, never as completion', async () => {
  const gateway = stepGateway({ verificationPassed: false });
  const fixed = planOf([step('a')], 'fast');
  const agent = agentWith(gateway, scriptedPlanner({ plans: [fixed] }), { maxReplans: 0 });
  const outcome = await agent.run(
    runRequest({ reasoning: 'fast', plan: fixed }),
    () => undefined,
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'verification_failed');
  assert.match(outcome.detail, /does not prove/);
});

test('the iteration bound stops an otherwise endless replan loop', async () => {
  const gateway = stepGateway({ failAllSteps: true });
  const agent = agentWith(
    gateway,
    scriptedPlanner({
      plans: [planOf([step('a')])],
      replans: [planOf([step('b')], 'complex', 2)],
    }),
    { maxReplans: 5, maxIterations: 3 },
  );
  const outcome = await agent.run(runRequest(), () => undefined);

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'iteration_exhausted');
});

test('a scoped action without approval escalates and never executes', async () => {
  const gateway = stepGateway();
  const readPlan = planOf([step('read-notes', [], 'read')]);
  const agent = createNativeAgent({
    enabled: true,
    gateway,
    planner: scriptedPlanner({ plans: [readPlan] }),
    authorizer: {
      authorize: async ({ scope }) =>
        scope === 'workspace.read'
          ? { decision: 'pending', requestId: 'req-1' }
          : { decision: 'allowed' },
    },
    limits: {
      maxSteps: 4,
      maxParallelSteps: 1,
      maxReplans: 0,
      maxStepAttempts: 1,
      maxIterations: 8,
    },
  });
  const events: AgentReportEvent[] = [];
  const outcome = await agent.run(
    runRequest({ reasoning: 'complex', plan: readPlan }),
    (event) => events.push(event),
  );

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'approval_required');
  assert.equal(events.some((event) => event.type === 'step.started'), false);
  assert.ok(
    events.some(
      (event) => event.type === 'approval.required' && event.requestId === 'req-1',
    ),
  );
  assert.equal(gateway.calls, 0);
});

function reasoningFixture() {
  const fixture = fakeGateway();
  return {
    id: fixture.id,
    get calls() { return fixture.calls; },
    complete: (request: ModelCompletionRequest) => fixture.complete({
      ...request, ownerId: 'owner', mode: 'cloud', operation: 'work',
    }),
  };
}

test('fast reasoning answers directly; complex reasoning plans, executes and verifies', async () => {
  const fastGateway = reasoningFixture();
  const fastAgent = agentWith(fastGateway);
  const fast = await fastAgent.run(
    runRequest({ objective: 'Summarize the repository', reasoning: 'fast', plan: null }),
    () => undefined,
  );
  assert.equal(fast.ok, true);
  if (!fast.ok) return;
  assert.equal(fast.verification?.passed, true);
  assert.equal(fastGateway.calls, 2);

  const complexGateway = reasoningFixture();
  const complexAgent = agentWith(complexGateway);
  const events: AgentReportEvent[] = [];
  const complex = await complexAgent.run(
    runRequest({
      objective: 'Audit the API surface and then draft the migration',
      reasoning: 'complex',
      plan: null,
    }),
    (event) => events.push(event),
  );
  assert.equal(complex.ok, true);
  if (!complex.ok) return;
  assert.equal(complex.verification?.passed, true);
  assert.equal(complexGateway.calls, 4);
  const created = events.find(
    (event): event is Extract<AgentReportEvent, { type: 'plan.ready' }> =>
      event.type === 'plan.ready',
  );
  assert.equal(created?.plan.mode, 'complex');
  assert.equal(created?.plan.steps.length, 2);
});
