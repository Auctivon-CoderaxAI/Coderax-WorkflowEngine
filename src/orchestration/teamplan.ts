import type { TeamCheck, TeamMemberSpec, TeamSubmitRequest } from '@coderax/contracts';
import type { ReasoningMode, TaskPlan, TaskPlanStep, TeamRecord } from '../domain.js';
import { resourceIsConfined, truncate, validatePlan } from '../agents/native/plan.js';

/**
 * A team is a plan whose steps are agents. Validation is the Native planner's
 * validation, applied to the owner's member graph, so there is one set of rules
 * for ids, dependencies, cycles and resources.
 */
export type TeamPlanResult =
  | { ok: true; plan: TaskPlan }
  | { ok: false; reason: string };

export function teamPlan(input: {
  mode: ReasoningMode;
  members: TeamMemberSpec[];
  maxMembers: number;
}): TeamPlanResult {
  if (input.members.length === 0) return { ok: false, reason: 'A team needs at least one member.' };
  if (input.members.length > input.maxMembers) {
    return {
      ok: false,
      reason: `A team may have at most ${input.maxMembers} members in this deployment.`,
    };
  }

  const steps: TaskPlanStep[] = input.members.map((member) => ({
    id: member.memberId,
    title: truncate(member.objective, 200),
    dependsOn: [...member.dependsOn],
    kind: 'reason',
  }));

  const validation = validatePlan({
    plan: { revision: 1, mode: input.mode, steps },
    completedSteps: [],
    maxSteps: input.maxMembers,
  });
  if (!validation.ok) return { ok: false, reason: validation.reason };

  for (const member of input.members) {
    const seen = new Set<string>();
    for (const resource of member.resources) {
      if (!resourceIsConfined(resource)) {
        return {
          ok: false,
          reason: `Member "${member.memberId}" names a resource outside the workspace.`,
        };
      }
      if (seen.has(resource)) {
        return {
          ok: false,
          reason: `Member "${member.memberId}" repeats resource "${resource}".`,
        };
      }
      seen.add(resource);
    }
  }

  return { ok: true, plan: { revision: 1, mode: input.mode, steps } };
}

/** Checks are validated up front; a check that cannot run is refused at submit. */
export function validateChecks(input: {
  checks: TeamCheck[];
  members: TeamMemberSpec[];
}): { ok: true } | { ok: false; reason: string } {
  const ids = new Set(input.members.map((member) => member.memberId));
  const seen = new Set<string>();
  for (const check of input.checks) {
    const key =
      check.kind === 'evidence' ? `evidence:${check.memberId}` : `${check.kind}:${check.path}`;
    if (seen.has(key)) return { ok: false, reason: `Check "${key}" is declared twice.` };
    seen.add(key);
    if (check.kind === 'evidence' && !ids.has(check.memberId)) {
      return { ok: false, reason: `Check "${key}" names a member that is not in the team.` };
    }
    if (check.kind !== 'evidence' && !resourceIsConfined(check.path)) {
      return { ok: false, reason: `Check "${key}" names a path outside the workspace.` };
    }
  }
  return { ok: true };
}

export function membersFromRequest(input: {
  teamId: string;
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
  request: TeamSubmitRequest;
  plan: TaskPlan;
  limits: TeamRecord['limits'];
  now: string;
}): TeamRecord {
  return {
    teamId: input.teamId,
    ownerId: input.ownerId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    mode: input.request.mode,
    objective: input.request.objective,
    reasoning:
      input.request.reasoning === 'fast' || input.request.reasoning === 'complex'
        ? input.request.reasoning
        : input.plan.mode,
    state: 'queued',
    generation: 1,
    runToken: null,
    members: input.request.members.map((member) => ({
      memberId: member.memberId,
      agent: member.agent,
      objective: member.objective,
      dependsOn: [...member.dependsOn],
      resources: [...member.resources],
      state: 'queued',
      attempts: 0,
    })),
    plan: input.plan,
    checks: input.request.checks ?? [],
    limits: input.limits,
    checkpoint: { completedMembers: [], outputs: {}, artifacts: [], evidence: [] },
    verification: null,
    failure: null,
    cancelRequested: false,
    budget: input.request.budget ?? null,
    usage: null,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
  };
}
