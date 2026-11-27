/**
 * Authoritative capability ownership.
 *
 * This is deliberately separate from the structural checker: the checker says
 * whether one runtime value satisfies a contract, while this table records which
 * branch/PR is allowed to own the capability when the work lands. A duplicate is
 * never resolved by deleting the newer code automatically; the finding names the
 * declared owner so the owners can reconcile the implementation at review.
 */
export type Authority = {
  owner: string;
  branch: string;
  contract: string;
};

export const AUTHORITIES: Readonly<Record<string, Authority>> = Object.freeze({
  model_router: {
    owner: 'PR #4',
    branch: 'feat/zero-cost-model-router',
    contract: 'src/models/router.ts (ModelRouter/Router)',
  },
  planner: {
    owner: 'PR #3',
    branch: 'feat/native-reasoning-planner',
    contract: 'src/agents/native/planner.ts (Planner)',
  },
  execution_supervisor: {
    owner: 'PR #5',
    branch: 'feat/execution-supervisor',
    contract: 'src/execution/supervisor.ts (ExecutionSupervisor/RunSupervisor)',
  },
  permission_gate: {
    owner: 'Security + execution owners',
    branch: 'security/remediation-808dfd3 + PR #5',
    contract: 'PermissionGate and the execution-scoped CapabilityBroker',
  },
  quota_ledger: {
    owner: 'PR #4 / model routing',
    branch: 'feat/zero-cost-model-router',
    contract: 'src/models/budget.ts (BudgetLedger)',
  },
  artifact_service: {
    owner: 'Durable Artifacts',
    branch: 'feat/durable-artifacts',
    contract: 'src/artifacts/service.ts (ArtifactService)',
  },
  capability_registry: {
    owner: 'Core agent discovery',
    branch: 'main',
    contract: 'src/agents/registry.ts (AgentRegistry)',
  },
  scheduler: {
    owner: 'Core execution',
    branch: 'main',
    contract: 'src/scheduling/scheduler.ts (TaskScheduler)',
  },
  schedule_engine: {
    owner: 'Durable Scheduling',
    branch: 'feat/durable-scheduling',
    contract: 'src/scheduling/engine.ts (ScheduleEngine)',
  },
  event_bus: {
    owner: 'Durable Events',
    branch: 'feat/durable-events-integration',
    contract: 'src/events/bus.ts (EventBus)',
  },
  event_log: {
    owner: 'Durable Events',
    branch: 'feat/durable-events-integration',
    contract: 'src/events/log.ts (EventLog)',
  },
  media_service: {
    owner: 'Multimodal Intelligence',
    branch: 'feat/multimodal-creative-intelligence',
    contract: 'src/media/service.ts (MediaService)',
  },
  creative_service: {
    owner: 'Multimodal Intelligence',
    branch: 'feat/multimodal-creative-intelligence',
    contract: 'src/creative/service.ts (CreativeService)',
  },
  task_runner: {
    owner: 'Core execution',
    branch: 'main',
    contract: 'src/execution/runner.ts (TaskRunner)',
  },
  application_service: {
    owner: 'Core orchestration',
    branch: 'main',
    contract: 'src/orchestration/service.ts (ApplicationService)',
  },
  http_router: {
    owner: 'Core API',
    branch: 'main',
    contract: 'src/api/router.ts (Router)',
  },
  route_registry: {
    owner: 'Core API',
    branch: 'main',
    contract: 'src/api/router.ts (RouteRegistry)',
  },
});

export function authorityFor(capability: string): Authority | null {
  return AUTHORITIES[capability] ?? null;
}
