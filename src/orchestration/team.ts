import { readFile } from 'node:fs/promises';
import type {
  PermissionList,
  TeamAccepted,
  TeamControlResult,
  TeamStatus,
  TeamSubmitRequest,
} from '@coderax/contracts';
import type { EngineConfig } from '../configuration/schema.js';
import type {
  TaskEvidence,
  TeamArtifact,
  TeamMemberRecord,
  TeamRecord,
  TeamVerificationRecord,
} from '../domain.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { AgentAdapter, AgentRunOutcome, AgentRunRequest } from '../agents/types.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { BudgetLedger } from '../models/budget.js';
import type { PermissionStore } from '../permissions/store.js';
import type { EventBus } from '../events/bus.js';
import type { ExecutionSupervisor } from '../execution/supervisor.js';
import type { ExecutionIdentity } from '../execution/identity.js';
import type { ResourceLockStore } from '../execution/locks.js';
import type { TeamRepository } from '../persistence/teams.js';
import type { TaskScheduler } from '../scheduling/scheduler.js';
import type { Principal } from '../security/auth.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { resolveEngineWorkspace, workspaceRoots } from '../execution/workspace.js';
import { confinePath } from '../tools/paths.js';
import { planWaves } from '../agents/native/schedule.js';
import { redactContent } from '../observability/redact.js';
import { membersFromRequest, teamPlan, validateChecks } from './teamplan.js';
import { digest, verifyTeam } from './teamverify.js';

/**
 * Coderax Native is the orchestrator. A team is a dependency graph of explicitly
 * selected agents; the engine orders them, scopes their resources, serializes
 * shared resources with durable locks, and proves completion from evidence.
 *
 * It deliberately owns no second scheduler, budget or event stream: members run
 * through the execution supervisor, spend through the engine's quota ledger, ask
 * the permission store, and publish to the durable execution event bus.
 */

export type TeamServiceDeps = {
  config: EngineConfig;
  clock: Clock;
  ids: IdGenerator;
  agents: AgentRegistry;
  models: ModelCatalog;
  budget: BudgetLedger;
  permissions: PermissionStore;
  events: EventBus;
  supervisor: ExecutionSupervisor;
  scheduler: TaskScheduler;
  teams: TeamRepository;
  locks: ResourceLockStore;
};

export type TeamService = {
  submit: (principal: Principal, request: TeamSubmitRequest) => Promise<ServiceResult<TeamAccepted>>;
  status: (principal: Principal, teamId: string) => Promise<ServiceResult<TeamStatus>>;
  cancel: (principal: Principal, teamId: string) => Promise<ServiceResult<TeamControlResult>>;
  resume: (
    principal: Principal,
    teamId: string,
    generation: number,
  ) => Promise<ServiceResult<TeamControlResult>>;
  permissions: (principal: Principal, teamId: string) => Promise<ServiceResult<PermissionList>>;
  decidePermission: (
    principal: Principal,
    teamId: string,
    body: { requestId: string; decision: 'approved' | 'denied'; reason?: string },
  ) => Promise<ServiceResult<PermissionList>>;
  /** Startup reconciliation: a replica that stopped leaves an interrupted team. */
  reconcile: () => Promise<{ interrupted: number }>;
  shutdown: () => Promise<void>;
};

type RunContext = {
  teamId: string;
  generation: number;
  token: string;
  controller: AbortController;
};

const HEARTBEAT_MS = 1_000;
const CANCEL_POLL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function sumUsage(
  left: TeamRecord['usage'],
  right: { inputTokens?: number; outputTokens?: number } | undefined,
): TeamRecord['usage'] {
  if (!right) return left;
  const input = (left?.inputTokens ?? 0) + (right.inputTokens ?? 0);
  const output = (left?.outputTokens ?? 0) + (right.outputTokens ?? 0);
  return {
    ...(input > 0 ? { inputTokens: input } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
  };
}

function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function createTeamService(deps: TeamServiceDeps): TeamService {
  const active = new Map<string, RunContext>();
  const memberExecutions = new Map<string, Set<string>>();
  let closed = false;

  async function reconcileStale(): Promise<{ interrupted: number }> {
    const now = deps.clock.now();
    const interrupted = await deps.teams.retireStale({
      before: new Date(now.getTime() - deps.config.teams.staleAfterMs).toISOString(),
      at: now.toISOString(),
    });
    return { interrupted };
  }

  // A replica can die after this process has started. Startup reconciliation
  // alone would leave its fresh-heartbeat team running forever, so sweep on a
  // bounded interval derived from the stale threshold.
  const sweep = setInterval(
    () => {
      if (!closed) void reconcileStale().catch(() => undefined);
    },
    Math.min(30_000, Math.max(1_000, Math.floor(deps.config.teams.staleAfterMs / 2))),
  );
  sweep.unref();

  function limitsFor(config: EngineConfig) {
    return {
      maxMembers: config.teams.maxMembers,
      maxParallel: config.teams.maxParallel,
      maxDurationMs: config.teams.maxDurationMs,
      maxStepsPerMember: config.teams.maxStepsPerMember,
    };
  }

  function publish(record: TeamRecord, type: Parameters<EventBus['publish']>[0]['type'], payload?: unknown): void {
    void deps.events.publish({
      taskId: record.teamId,
      runToken: record.runToken ?? '',
      agent: 'coderax',
      generation: record.generation,
      type,
      ...(payload === undefined ? {} : { payload }),
    }).catch(() => undefined);
  }

  function statusOf(record: TeamRecord): TeamStatus {
    return {
      teamId: record.teamId,
      objective: record.objective,
      mode: record.mode,
      state: record.state,
      generation: record.generation,
      members: record.members.map((member) => ({
        memberId: member.memberId,
        agent: member.agent,
        objective: member.objective,
        dependsOn: member.dependsOn,
        resources: member.resources,
        state: member.state,
        attempts: member.attempts,
        ...(member.executionId ? { executionId: member.executionId } : {}),
        ...(member.summary ? { summary: bounded(member.summary, 4000) } : {}),
        ...(member.evidence ? { evidence: bounded(member.evidence, 4000) } : {}),
        ...(member.failure?.code ? { failureCode: member.failure.code } : {}),
        ...(member.failure?.detail ? { failureDetail: bounded(member.failure.detail, 2000) } : {}),
        ...(member.startedAt ? { startedAt: member.startedAt } : {}),
        ...(member.finishedAt ? { finishedAt: member.finishedAt } : {}),
      })),
      limits: record.limits,
      verification: record.verification,
      failure: record.failure,
      usage: record.usage
        ? {
            ...(record.usage.inputTokens !== undefined ? { inputTokens: record.usage.inputTokens } : {}),
            ...(record.usage.outputTokens !== undefined ? { outputTokens: record.usage.outputTokens } : {}),
          }
        : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  async function readArtifact(
    root: string,
    path: string,
  ): Promise<{ bytes: number; sha256: string; text: string } | null> {
    const confined = await confinePath(root, path);
    if (!confined.ok) return null;
    try {
      const buffer = await readFile(confined.path);
      if (buffer.byteLength > deps.config.teams.maxArtifactBytes) return null;
      return {
        bytes: buffer.byteLength,
        sha256: digest(buffer),
        text: buffer.toString('utf8'),
      };
    } catch {
      return null;
    }
  }

  /** Exact-resource grants, one binding per member, checked before any read. */
  async function ensurePermissions(input: {
    record: TeamRecord;
    member: TeamMemberRecord;
    signal: AbortSignal;
  }): Promise<
    | { ok: true }
    | { ok: false; kind: 'denied' | 'suspended'; requestIds: string[]; detail: string }
  > {
    if (input.signal.aborted) {
      return { ok: false, kind: 'denied', requestIds: [], detail: 'The team was cancelled.' };
    }
    const pending: string[] = [];
    for (const resource of [...new Set(input.member.resources)]) {
      const binding = input.member.memberId;
      const decision = await deps.permissions.lookup({
        ownerId: input.record.ownerId,
        taskId: input.record.teamId,
        scope: 'workspace.read',
        resource,
        binding,
        consume: false,
      });
      if (decision?.decision === 'granted') continue;
      if (decision?.decision === 'denied') {
        return {
          ok: false,
          kind: 'denied',
          requestIds: [],
          detail: `The owner denied workspace.read for "${resource}" for member "${input.member.memberId}".`,
        };
      }
      if (decision?.decision === 'pending' && decision.requestId) {
        pending.push(decision.requestId);
        continue;
      }
      const request = await deps.permissions.request({
        ownerId: input.record.ownerId,
        taskId: input.record.teamId,
        agent: input.member.agent,
        scope: 'workspace.read',
        resource,
        binding,
        description: `Read "${resource}" for team member "${input.member.memberId}".`,
        ttlMs: 30 * 60_000,
      });
      pending.push(request.requestId);
      publish(input.record, 'approval.required', {
        requestId: request.requestId,
        tool: 'workspace.read',
        description: bounded(request.description, 2000),
      });
    }
    if (pending.length > 0) {
      return {
        ok: false,
        kind: 'suspended',
        requestIds: pending,
        detail: 'Owner approval is required before this member may read its resources.',
      };
    }
    return { ok: true };
  }

  async function acquireLocks(input: {
    record: TeamRecord;
    member: TeamMemberRecord;
    owner: string;
  }): Promise<{ ok: true; keys: string[] } | { ok: false; detail: string }> {
    const keys = [...new Set(input.member.resources)].sort();
    const acquired: string[] = [];
    for (const key of keys) {
      const result = await deps.locks.acquire({
        key,
        ownerId: input.record.ownerId,
        owner: input.owner,
        ttlMs: input.record.limits.maxDurationMs + 60_000,
        now: deps.clock.now(),
      });
      if (!result.acquired) {
        for (const held of acquired) {
          await deps.locks.release({ key: held, owner: input.owner }).catch(() => false);
        }
        return {
          ok: false,
          detail: result.holder
            ? `Resource "${key}" is locked by another execution.`
            : `Resource "${key}" is locked by another replica.`,
        };
      }
      acquired.push(key);
    }
    return { ok: true, keys };
  }

  async function releaseLocks(input: { keys: string[]; owner: string }): Promise<void> {
    await Promise.all(
      input.keys.map((key) => deps.locks.release({ key, owner: input.owner }).catch(() => false)),
    );
  }

  function memberObjective(input: {
    record: TeamRecord;
    checkpoint: TeamRecord['checkpoint'];
    member: TeamMemberRecord;
    artifacts: TeamArtifact[];
  }): string {
    const prior = input.member.dependsOn
      .map((id) => input.checkpoint.outputs[id])
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .map((text, index) => `Dependency result ${index + 1}:\n${bounded(redactContent(text), 1500)}`);
    const excerpts = input.artifacts
      .filter((artifact) => input.member.resources.includes(artifact.path))
      .map((artifact) => {
        const text = input.checkpoint.outputs[`artifact:${artifact.path}`] ?? '';
        return `Resource "${artifact.path}" (sha256 ${artifact.sha256.slice(0, 12)}…, ${artifact.bytes} bytes):\n${bounded(redactContent(text), 2000)}`;
      });
    return [
      `Team objective:\n${input.record.objective}`,
      `Your assignment (${input.member.memberId}):\n${input.member.objective}`,
      ...prior,
      ...excerpts,
      'Return the concrete result of your assignment. Do not claim a team-level verdict; the engine verifies completion from persisted evidence.',
    ].join('\n\n');
  }

  async function runMember(input: {
    record: TeamRecord;
    /** The live checkpoint, including this wave's reads and prior results. */
    checkpoint: TeamRecord['checkpoint'];
    member: TeamMemberRecord;
    adapter: AgentAdapter;
    model: { providerId: string; modelId: string };
    workspaceRoot: string;
    context: RunContext;
    artifacts: TeamArtifact[];
    deadlineAt: number;
  }): Promise<
    | { ok: true; summary: string; usage?: { inputTokens?: number; outputTokens?: number }; executionId: string }
    | { ok: false; code: string; detail: string; retryable: boolean; executionId: string }
  > {
    const executionId = deps.ids.executionId();
    const identity: ExecutionIdentity = {
      executionId,
      kind: 'team',
      taskId: null,
      conversationId: input.record.conversationId,
      ownerId: input.record.ownerId,
      tenantId: input.record.tenantId,
      agent: input.member.agent,
      mode: input.record.mode,
      generation: input.record.generation,
      token: null,
    };
    const ids = memberExecutions.get(input.record.teamId) ?? new Set<string>();
    ids.add(executionId);
    memberExecutions.set(input.record.teamId, ids);

    const request: AgentRunRequest = {
      ownerId: input.record.ownerId,
      tenantId: input.record.tenantId,
      conversationId: input.record.conversationId,
      objective: memberObjective({
        record: input.record,
        checkpoint: input.checkpoint,
        member: input.member,
        artifacts: input.artifacts,
      }),
      history: [],
      model: input.model,
      mode: input.record.mode,
      routing: 'auto', allowFallback: false, operation: 'work',
      workspaceRoot: input.workspaceRoot,
      maxSteps: input.record.limits.maxStepsPerMember,
      budget: input.record.budget,
      signal: input.context.controller.signal,
    };

    const reservation = input.adapter.engine === 'native' ? null : await deps.budget.reserve({
      ownerId: input.record.ownerId, at: deps.clock.now(), inputTokens: Math.ceil(request.objective.length / 4),
      outputTokens: request.budget?.maxOutputTokens ?? 1024,
    });
    if (reservation && !reservation.allowed) return { ok: false, code: 'budget_exhausted', detail: reservation.detail, retryable: true, executionId };
    const held = reservation?.allowed ? reservation.reservation : null;
    let dispatched = false;
    let chargedUsage: { inputTokens?: number; outputTokens?: number } = {};
    const supervised = deps.supervisor.run({
      identity,
      adapter: input.adapter,
      workspaceRoot: input.workspaceRoot,
      scopes: ['workspace.read'],
      // The supervisor drops this sink the moment authority is revoked, so a
      // cancelled external member cannot keep streaming or reporting.
      report: () => undefined,
      launch: async (execution) => {
        const outcome: AgentRunOutcome = await input.adapter.run(
          { ...request, signal: execution.signal },
          execution.report,
          () => { dispatched = !execution.signal.aborted; return dispatched; },
        );
        if (outcome.ok) chargedUsage = outcome.usage ?? {};
        if (outcome.ok) {
          return {
            outcome: {
              kind: 'completed',
              summary: outcome.summary,
              ...(outcome.usage ? { usage: outcome.usage } : {}),
            },
          };
        }
        if (outcome.code === 'cancelled') {
          return { outcome: { kind: 'cancelled' } };
        }
        if (outcome.code === 'approval_required') {
          return { outcome: { kind: 'suspended', detail: outcome.detail } };
        }
        return {
          outcome: {
            kind: 'failed',
            code: outcome.code,
            detail: outcome.detail,
            retryable: outcome.retryable,
          },
        };
      },
    }).finally(async () => {
      if (!held) return;
      if (dispatched) await deps.budget.settle(held.id, chargedUsage);
      else await deps.budget.release(held.id);
    });

    /**
     * A member is bounded by two clocks that always end: the team deadline and,
     * after a cancellation, the configured grace. Neither fires on a healthy run.
     */
    let stoppedBy: 'cancel' | 'timeout' | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let cancelPoll: NodeJS.Timeout | null = null;
    const onAbort = (): void => {
      if (graceTimer) return;
      graceTimer = setTimeout(() => {
        stoppedBy = 'cancel';
      }, deps.config.teams.cancelGraceMs);
      graceTimer.unref();
    };
    if (input.context.controller.signal.aborted) onAbort();
    else input.context.controller.signal.addEventListener('abort', onAbort, { once: true });
    const boundedWait = new Promise<null>((resolve) => {
      deadlineTimer = setTimeout(
        () => {
          if (stoppedBy === null) stoppedBy = 'timeout';
          resolve(null);
        },
        Math.max(1, input.deadlineAt - deps.clock.now().getTime()),
      );
      deadlineTimer.unref();
      cancelPoll = setInterval(() => {
        if (stoppedBy !== 'cancel') return;
        if (cancelPoll) clearInterval(cancelPoll);
        resolve(null);
      }, 25);
      cancelPoll.unref();
    });

    const supervisedResult = await Promise.race([supervised, boundedWait]);
    input.context.controller.signal.removeEventListener('abort', onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (cancelPoll) clearInterval(cancelPoll);

    if (supervisedResult === null) {
      // The adapter did not stop within its bound. Revoking authority is
      // synchronous: even while the adapter is still running, it cannot start
      // another tool call or publish another event.
      deps.supervisor.cancel(executionId, stoppedBy === 'timeout' ? 'team_deadline' : 'team_cancelled');
      return {
        ok: false,
        code: stoppedBy === 'timeout' ? 'timeout' : 'cancelled',
        detail:
          stoppedBy === 'timeout'
            ? 'The member exceeded the team execution bound.'
            : 'The member did not stop within the cancellation grace period.',
        retryable: stoppedBy === 'timeout',
        executionId,
      };
    }

    ids.delete(executionId);
    if (!supervisedResult.admitted) {
      return {
        ok: false,
        code: supervisedResult.code === 'workspace_denied' ? 'workspace_denied' : 'server_unavailable',
        detail: supervisedResult.detail,
        retryable: false,
        executionId,
      };
    }
    if (supervisedResult.cause === 'cancelled') {
      return {
        ok: false,
        code: 'cancelled',
        detail: 'The member was cancelled.',
        retryable: false,
        executionId,
      };
    }
    if (supervisedResult.cause === 'interrupted' || supervisedResult.cause === 'shutdown') {
      return {
        ok: false,
        code: 'cancelled',
        detail: 'The member lost execution authority.',
        retryable: false,
        executionId,
      };
    }
    if (supervisedResult.outcome.kind === 'completed') {
      return {
        ok: true,
        summary: supervisedResult.outcome.summary,
        ...(supervisedResult.outcome.usage ? { usage: supervisedResult.outcome.usage } : {}),
        executionId,
      };
    }
    if (supervisedResult.outcome.kind === 'cancelled') {
      return {
        ok: false,
        code: 'cancelled',
        detail: 'The member was cancelled.',
        retryable: false,
        executionId,
      };
    }
    if (supervisedResult.outcome.kind === 'suspended') {
      return {
        ok: false,
        code: 'approval_required',
        detail: supervisedResult.outcome.detail,
        retryable: false,
        executionId,
      };
    }
    if (supervisedResult.outcome.kind === 'failed') {
      return {
        ok: false,
        code: supervisedResult.outcome.code,
        detail: supervisedResult.outcome.detail,
        retryable: supervisedResult.outcome.retryable,
        executionId,
      };
    }
    return {
      ok: false,
      code: 'provider_error',
      detail: 'The member ended without a usable result.',
      retryable: false,
      executionId,
    };
  }

  async function settle(
    record: TeamRecord,
    token: string,
    patch: Parameters<TeamRepository['updateFenced']>[0]['patch'],
  ): Promise<boolean> {
    const result = await deps.teams.updateFenced({
      teamId: record.teamId,
      token,
      generation: record.generation,
      patch: { ...patch, updatedAt: deps.clock.iso() },
    });
    return result.applied;
  }

  async function finish(input: {
    record: TeamRecord;
    token: string;
    state: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    failure?: TeamRecord['failure'];
    verification?: TeamVerificationRecord | null;
    usage?: TeamRecord['usage'];
    memberPatch?: Pick<TeamRecord, 'members' | 'checkpoint'>;
  }): Promise<void> {
    const at = deps.clock.iso();
    const applied = await settle(input.record, input.token, {
      state: input.state,
      finishedAt: at,
      runToken: null,
      heartbeatAt: at,
      failure: input.failure ?? null,
      ...(input.verification !== undefined ? { verification: input.verification } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.memberPatch ?? {}),
    });
    if (!applied) return;
    const type =
      input.state === 'completed'
        ? 'task.completed'
        : input.state === 'cancelled'
          ? 'task.cancelled'
          : input.state === 'interrupted'
            ? 'task.interrupted'
            : 'task.failed';
    publish({ ...input.record, ...(input.memberPatch ?? {}), state: input.state, runToken: null }, type, {
      ...(input.state === 'completed' ? { summary: 'Team completed with verified evidence.' } : {}),
      ...(input.failure ? { failure: input.failure } : {}),
    });
    await deps.events.flush(input.record.teamId).catch(() => undefined);
  }

  async function execute(record: TeamRecord, token: string): Promise<void> {
    const context: RunContext = {
      teamId: record.teamId,
      generation: record.generation,
      token,
      controller: new AbortController(),
    };
    active.set(record.teamId, context);

    const heartbeat = setInterval(() => {
      void deps.teams.heartbeat({ teamId: record.teamId, token, at: deps.clock.iso() }).catch(() => false);
    }, HEARTBEAT_MS);
    heartbeat.unref();

    // A cancel may arrive on another replica, so it is observed from the durable
    // record rather than only from this process's in-memory controller.
    const watcher = setInterval(() => {
      void deps.teams
        .get(record.ownerId, record.teamId)
        .then((current) => {
          if (!current?.cancelRequested) return;
          context.controller.abort();
          for (const executionId of memberExecutions.get(record.teamId) ?? []) {
            deps.supervisor.cancel(executionId, 'team_cancelled');
          }
        })
        .catch(() => undefined);
    }, CANCEL_POLL_MS);
    watcher.unref();

    const deadline = deps.clock.now().getTime() + record.limits.maxDurationMs;
    let usage: TeamRecord['usage'] = record.usage;
    let members: TeamMemberRecord[] = structuredClone(record.members);
    let checkpoint = structuredClone(record.checkpoint);

    try {
      const workspace = await resolveEngineWorkspace({
        mode: record.mode,
        roots: workspaceRoots(deps.config.workspaces),
      });
      if (!workspace.ok) {
        await finish({
          record,
          token,
          state: 'failed',
          failure: { code: 'workspace_denied', detail: workspace.detail, retryable: false },
        });
        return;
      }

      const resolved = deps.models.resolve(null, record.mode);
      if (!resolved.ok) {
        await finish({
          record,
          token,
          state: 'failed',
          failure: {
            code: resolved.code === 'paid_model_refused' ? 'paid_model_refused' : 'model_missing',
            detail: resolved.detail,
            retryable: false,
          },
        });
        return;
      }
      const model = resolved.value.ref;

      for (;;) {
        const current = await deps.teams.get(record.ownerId, record.teamId);
        if (!current || current.runToken !== token || current.generation !== record.generation) {
          return;
        }
        if (current.cancelRequested) {
          members = members.map((member) =>
            member.state === 'queued' || member.state === 'running'
              ? { ...member, state: 'cancelled', finishedAt: deps.clock.iso() }
              : member,
          );
          await finish({
            record,
            token,
            state: 'cancelled',
            failure: { code: 'cancelled', detail: 'The owner cancelled the team.', retryable: false },
            usage,
            memberPatch: { members, checkpoint },
          });
          return;
        }
        if (deps.clock.now().getTime() > deadline) {
          await finish({
            record,
            token,
            state: 'failed',
            failure: {
              code: 'timeout',
              detail: `The team exceeded its ${record.limits.maxDurationMs}ms bound.`,
              retryable: true,
            },
            usage,
            memberPatch: { members, checkpoint },
          });
          return;
        }

        const completed = new Set(checkpoint.completedMembers);
        if (completed.size === record.plan.steps.length) break;

        const schedule = planWaves({
          steps: record.plan.steps,
          completed,
          maxParallel: record.limits.maxParallel,
        });
        if (!schedule.ok) {
          await finish({
            record,
            token,
            state: 'failed',
            failure: { code: 'protocol_error', detail: schedule.reason, retryable: false },
            usage,
            memberPatch: { members, checkpoint },
          });
          return;
        }
        const wave = schedule.waves[0] ?? [];
        if (wave.length === 0) break;

        // Admission and permission preparation happen for the whole wave before
        // any member starts. An approval suspension therefore never runs half a
        // wave, and the owner sees every grant the wave needs at once.
        const admitted: Array<{ member: TeamMemberRecord; adapter: AgentAdapter }> = [];
        let suspension: string | null = null;
        for (const step of wave) {
          const member = members.find((entry) => entry.memberId === step.id);
          if (!member) continue;
          const adapter = deps.agents.get(member.agent);
          if (!adapter || !adapter.availability().available) {
            await finish({
              record,
              token,
              state: 'failed',
              failure: {
                code: 'not_configured',
                detail: `The ${member.agent} agent selected for member "${member.memberId}" is unavailable; it is not replaced.`,
                retryable: false,
              },
              usage,
              memberPatch: { members, checkpoint },
            });
            return;
          }
          const permission = await ensurePermissions({ record, member, signal: context.controller.signal });
          if (!permission.ok) {
            if (permission.kind === 'denied') {
              await finish({
                record,
                token,
                state: 'failed',
                failure: { code: 'permission_required', detail: permission.detail, retryable: false },
                usage,
                memberPatch: { members, checkpoint },
              });
              return;
            }
            suspension = permission.detail;
            continue;
          }
          admitted.push({ member, adapter });
        }
        if (suspension !== null) {
          await settle(record, token, {
            state: 'awaiting_approval',
            failure: { code: 'approval_required', detail: suspension, retryable: true },
            runToken: null,
            heartbeatAt: deps.clock.iso(),
            updatedAt: deps.clock.iso(),
          });
          await deps.events.flush(record.teamId).catch(() => undefined);
          return;
        }

        const prepared: Array<{ member: TeamMemberRecord; artifacts: TeamArtifact[]; lockOwner: string }> = [];
        const releasePreparedLocks = async (): Promise<void> => {
          await Promise.all(
            prepared.map((entry) =>
              releaseLocks({ keys: entry.member.resources, owner: entry.lockOwner }),
            ),
          );
        };
        for (const { member } of admitted) {
          const lockOwner = `${record.teamId}:${record.generation}:${member.memberId}`;
          const locks = await acquireLocks({ record, member, owner: lockOwner });
          if (!locks.ok) {
            // Earlier members in this wave have not started yet; their locks
            // must not outlive a preparation that will never dispatch them.
            await releasePreparedLocks();
            await finish({
              record,
              token,
              state: 'failed',
              failure: { code: 'resource_locked', detail: locks.detail, retryable: true },
              usage,
              memberPatch: { members, checkpoint },
            });
            return;
          }

          const artifacts: TeamArtifact[] = [];
          for (const resource of [...new Set(member.resources)]) {
            const artifact = await readArtifact(workspace.value.root, resource);
            if (!artifact) {
              await releaseLocks({ keys: locks.keys, owner: lockOwner });
              await releasePreparedLocks();
              await finish({
                record,
                token,
                state: 'failed',
                failure: {
                  code: 'not_found',
                  detail: `Member "${member.memberId}" could not read its resource "${resource}".`,
                  retryable: false,
                },
                usage,
                memberPatch: { members, checkpoint },
              });
              return;
            }
            artifacts.push({
              path: resource,
              bytes: artifact.bytes,
              sha256: artifact.sha256,
              memberId: member.memberId,
            });
            checkpoint = {
              ...checkpoint,
              outputs: {
                ...checkpoint.outputs,
                [`artifact:${resource}`]: artifact.text.slice(0, deps.config.teams.maxEvidenceChars),
              },
              artifacts: [
                ...checkpoint.artifacts.filter((entry) => entry.path !== resource),
                {
                  path: resource,
                  bytes: artifact.bytes,
                  sha256: artifact.sha256,
                  memberId: member.memberId,
                },
              ],
            };
          }
          prepared.push({ member, artifacts, lockOwner });
        }

        // Run the wave concurrently, bounded by maxParallel from planWaves.
        const results = await Promise.all(
          prepared.map(async ({ member, artifacts, lockOwner }) => {
            const adapter = deps.agents.get(member.agent);
            if (!adapter) {
              return {
                member,
                ok: false as const,
                code: 'not_configured',
                detail: 'The agent is unavailable.',
                retryable: false,
                executionId: '',
              };
            }
            members = members.map((entry) =>
              entry.memberId === member.memberId
                ? { ...entry, state: 'running', attempts: entry.attempts + 1, startedAt: deps.clock.iso() }
                : entry,
            );
            publish(record, 'step.started', { stepId: member.memberId, title: bounded(member.objective, 200) });
            try {
              return {
                member,
                ...(await runMember({
                  record,
                  checkpoint,
                  member,
                  adapter,
                  model,
                  workspaceRoot: workspace.value.root,
                  context,
                  artifacts,
                  deadlineAt: deadline,
                })),
              };
            } finally {
              await releaseLocks({ keys: member.resources, owner: lockOwner });
            }
          }),
        );

        let failure: {
          code: string;
          detail: string;
          retryable: boolean;
          cancelled: boolean;
        } | null = null;
        for (const result of results) {
          const at = deps.clock.iso();
          if (result.ok) {
            const safeSummary = redactContent(result.summary);
            members = members.map((entry) =>
              entry.memberId === result.member.memberId
                ? {
                    ...entry,
                    state: 'completed',
                    executionId: result.executionId,
                    summary: bounded(safeSummary, 4000),
                    evidence: bounded(safeSummary, deps.config.teams.maxEvidenceChars),
                    finishedAt: at,
                    ...(result.usage ? { usage: result.usage } : {}),
                  }
                : entry,
            );
            const evidence: TaskEvidence = {
              stepId: result.member.memberId,
              title: bounded(result.member.objective, 200),
              output: bounded(safeSummary, deps.config.teams.maxEvidenceChars),
              citation: checkpoint.artifacts.some((entry) => entry.memberId === result.member.memberId)
                ? checkpoint.artifacts
                    .filter((entry) => entry.memberId === result.member.memberId)
                    .map((entry) => `${entry.path}#${entry.sha256.slice(0, 12)}`)
                    .join(', ')
                : `member:${result.member.memberId}`,
              attempts: result.member.attempts + 1,
            };
            checkpoint = {
              ...checkpoint,
              completedMembers: [...new Set([...checkpoint.completedMembers, result.member.memberId])],
              outputs: { ...checkpoint.outputs, [result.member.memberId]: evidence.output },
              evidence: [...checkpoint.evidence.filter((entry) => entry.stepId !== evidence.stepId), evidence],
            };
            usage = sumUsage(usage, result.usage);
            publish(record, 'step.completed', {
              stepId: result.member.memberId,
              title: bounded(result.member.objective, 200),
            });
          } else {
            const cancelled = result.code === 'cancelled';
            members = members.map((entry) =>
              entry.memberId === result.member.memberId
                ? {
                    ...entry,
                    state: cancelled ? 'cancelled' : 'failed',
                    executionId: result.executionId,
                    failure: { code: result.code, detail: bounded(result.detail, 2000), retryable: result.retryable },
                    finishedAt: at,
                  }
                : entry,
            );
            failure ??= {
              code: result.code,
              detail: bounded(result.detail, 2000),
              retryable: result.retryable,
              cancelled,
            };
          }
        }
        if (failure) {
          // No sibling may remain `running` after its wave ends. Siblings that
          // were already dispatched are terminal before the team settles.
          const waveIds = new Set(prepared.map((entry) => entry.member.memberId));
          members = members.map((entry) =>
            entry.state === 'running' || (waveIds.has(entry.memberId) && entry.state === 'queued')
              ? {
                  ...entry,
                  state: failure?.cancelled ? 'cancelled' : 'skipped',
                  finishedAt: deps.clock.iso(),
                }
              : entry,
          );
          await finish({
            record,
            token,
            state: failure.cancelled ? 'cancelled' : 'failed',
            failure: { code: failure.code, detail: failure.detail, retryable: failure.retryable },
            usage,
            memberPatch: { members, checkpoint },
          });
          return;
        }

        // Persist progress before the next wave: this is the checkpoint a
        // restart resumes from.
        const applied = await settle(record, token, {
          members: structuredClone(members),
          checkpoint: structuredClone(checkpoint),
          usage,
        });
        if (!applied) return;
      }

      const verification = await verifyTeam({
        record: { ...record, members, checkpoint },
        maxArtifactBytes: deps.config.teams.maxArtifactBytes,
        read: (path) => readArtifact(workspace.value.root, path),
      });
      if (!verification.passed) {
        await finish({
          record,
          token,
          state: 'failed',
          failure: {
            code: 'verification_failed',
            detail: verification.reason,
            retryable: false,
          },
          usage,
          verification,
          memberPatch: { members, checkpoint },
        });
        return;
      }
      await finish({
        record,
        token,
        state: 'completed',
        verification,
        usage,
        memberPatch: { members, checkpoint },
      });
    } catch {
      // A persistence or engine failure must not leave the team `running`. If the
      // fence still belongs to this generation, record a typed failure; otherwise
      // another generation owns the record and this one writes nothing.
      await finish({
        record,
        token,
        state: 'failed',
        failure: { code: 'server_unavailable', detail: 'The team run failed unexpectedly.', retryable: true },
        usage,
        memberPatch: { members, checkpoint },
      }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      clearInterval(watcher);
      memberExecutions.delete(record.teamId);
      if (active.get(record.teamId) === context) active.delete(record.teamId);
    }
  }

  return {
    submit: async (principal, request) => {
      const plan = teamPlan({
        mode: request.reasoning === 'fast' ? 'fast' : request.reasoning === 'complex' ? 'complex' : 'complex',
        members: request.members,
        maxMembers: deps.config.teams.maxMembers,
      });
      if (!plan.ok) return fail('validation_failed', plan.reason);
      const checks = validateChecks({ checks: request.checks ?? [], members: request.members });
      if (!checks.ok) return fail('validation_failed', checks.reason);
      if (!(await deps.budget.available(principal.ownerId, deps.clock.now()))) {
        return fail(
          'budget_exhausted',
          'The daily zero-cost budget is exhausted; the team was refused rather than routed to a paid path.',
        );
      }

      const teamId = deps.ids.teamId();
      const now = deps.clock.iso();
      const record = membersFromRequest({
        teamId,
        ownerId: principal.ownerId,
        tenantId: null,
        conversationId: deps.ids.conversationId(),
        request,
        plan: plan.plan,
        limits: limitsFor(deps.config),
        now,
      });
      if (!(await deps.teams.create(record))) {
        return fail('conflict', 'That team already exists.');
      }
      publish(record, 'task.queued');
      await deps.events.flush(record.teamId);

      const token = deps.ids.runToken();
      const claimed = await deps.teams.claim({
        teamId,
        generation: 1,
        token,
        at: now,
      });
      if (!claimed) return fail('conflict', 'The team could not be claimed.');
      deps.scheduler.enqueue(() => execute(claimed, token));
      return ok({ teamId, state: claimed.state, generation: claimed.generation, acceptedAt: now });
    },

    status: async (principal, teamId) => {
      const record = await deps.teams.get(principal.ownerId, teamId);
      if (!record) return fail('not_found', 'That team does not exist.');
      return ok(statusOf(record));
    },

    cancel: async (principal, teamId) => {
      const record = await deps.teams.get(principal.ownerId, teamId);
      if (!record) return fail('not_found', 'That team does not exist.');
      if (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') {
        return fail('conflict', `The team is already ${record.state}.`);
      }
      const at = deps.clock.iso();
      const requested = await deps.teams.requestCancel({ ownerId: principal.ownerId, teamId, at });
      if (!requested) return fail('not_found', 'That team does not exist.');
      const context = active.get(teamId);
      context?.controller.abort();
      for (const executionId of memberExecutions.get(teamId) ?? []) {
        deps.supervisor.cancel(executionId, 'team_cancelled');
      }
      // A suspended or interrupted team has no execution loop left to observe
      // the flag. Settle it atomically even if a context object is still
      // draining: it may already have cleared its run token, and the update
      // itself refuses to touch a team that still has one.
      const inactive = await deps.teams.cancelInactive({
        ownerId: principal.ownerId,
        teamId,
        at,
      });
      publish({ ...(inactive ?? record), cancelRequested: true }, 'task.cancelled', {
        reason: 'owner_cancelled',
      });
      await deps.events.flush(teamId).catch(() => undefined);
      const latest = await deps.teams.get(principal.ownerId, teamId);
      if (!latest) return fail('not_found', 'That team does not exist.');
      return ok({ teamId, outcome: 'accepted', state: latest.state, generation: latest.generation });
    },

    resume: async (principal, teamId, generation) => {
      const record = await deps.teams.get(principal.ownerId, teamId);
      if (!record) return fail('not_found', 'That team does not exist.');
      if (record.generation !== generation) {
        return fail('conflict', 'That team generation has been superseded.');
      }
      if (record.state !== 'interrupted' && record.state !== 'awaiting_approval') {
        return fail('conflict', `A team in state ${record.state} cannot be resumed.`);
      }
      const at = deps.clock.iso();
      const resumed = await deps.teams.resume({
        teamId,
        ownerId: principal.ownerId,
        expectedGeneration: generation,
        at,
      });
      if (!resumed) return fail('conflict', 'The team could not be resumed.');
      const token = deps.ids.runToken();
      const claimed = await deps.teams.claim({
        teamId,
        generation: resumed.generation,
        token,
        at,
      });
      if (!claimed) return fail('conflict', 'The team could not be claimed.');
      deps.scheduler.enqueue(() => execute(claimed, token));
      return ok({
        teamId,
        outcome: 'accepted',
        state: claimed.state,
        generation: claimed.generation,
      });
    },

    permissions: async (principal, teamId) => {
      const record = await deps.teams.get(principal.ownerId, teamId);
      if (!record) return fail('not_found', 'That team does not exist.');
      return ok(await deps.permissions.list(principal.ownerId, teamId));
    },

    decidePermission: async (principal, teamId, body) => {
      const record = await deps.teams.get(principal.ownerId, teamId);
      if (!record) return fail('not_found', 'That team does not exist.');
      const decided = await deps.permissions.decide({
        ownerId: principal.ownerId,
        taskId: teamId,
        requestId: body.requestId,
        decision: body.decision,
        ...(body.reason ? { reason: body.reason } : {}),
      });
      return decided;
    },

    reconcile: reconcileStale,

    shutdown: async () => {
      closed = true;
      clearInterval(sweep);
      for (const context of active.values()) {
        context.controller.abort();
        for (const executionId of memberExecutions.get(context.teamId) ?? []) {
          deps.supervisor.cancel(executionId, 'team_shutdown');
        }
      }
      const ids = [...active.keys()];
      const started = Date.now();
      while (active.size > 0 && Date.now() - started < deps.config.execution.cancelGraceMs) {
        await delay(20);
      }
      for (const id of ids) active.delete(id);
      await deps.events.close().catch(() => undefined);
    },
  };
}
