import type { EngineConfig } from '../configuration/schema.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { AuthService } from '../security/auth.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { ModelCatalog } from '../models/catalog.js';
import type { BudgetLedger } from '../models/budget.js';
import type { LeaseStore } from '../execution/lease.js';
import type { TaskRepository } from '../persistence/tasks.js';
import type { ConversationRepository } from '../persistence/conversations.js';
import type { NotificationStore } from '../persistence/notifications.js';
import type { MemoryStore } from '../memory/store.js';
import type { PermissionStore } from '../permissions/store.js';
import type { AuditLog } from '../observability/audit.js';
import type { HealthService } from '../observability/health.js';
import type { EventBus } from '../events/bus.js';
import type { TaskRunner } from '../execution/runner.js';
import type { TaskScheduler } from '../scheduling/scheduler.js';
import type { QuarantineRegistry } from '../execution/quarantine.js';
import type { ApplicationService } from '../orchestration/service.js';
import type { Router } from '../api/router.js';

/**
 * Dependencies are named, not positional.
 *
 * Every collaborator is supplied by name and validated at composition time, so a
 * missing or null dependency is a startup error naming the field instead of a
 * runtime failure inside a request. Adding a dependency means adding a field here
 * and a builder in the composition root; nothing constructs its own collaborators.
 */
export type InfrastructureDependencies = {
  config: EngineConfig;
  clock: Clock;
  ids: IdGenerator;
  auth: AuthService;
  agents: AgentRegistry;
  models: ModelCatalog;
  budget: BudgetLedger;
  lease: LeaseStore;
  tasks: TaskRepository;
  conversations: ConversationRepository;
  memory: MemoryStore;
  permissions: PermissionStore;
  notifications: NotificationStore;
  audit: AuditLog;
  events: EventBus;
  runner: TaskRunner;
  scheduler: TaskScheduler;
  health: HealthService;
  quarantine: QuarantineRegistry;
};

export const INFRASTRUCTURE_DEPENDENCIES = [
  'config',
  'clock',
  'ids',
  'auth',
  'agents',
  'models',
  'budget',
  'lease',
  'tasks',
  'conversations',
  'memory',
  'permissions',
  'notifications',
  'audit',
  'events',
  'runner',
  'scheduler',
  'health',
  'quarantine',
] as const satisfies readonly (keyof InfrastructureDependencies)[];

export type ApplicationDependencies = InfrastructureDependencies & {
  service: ApplicationService;
  router: Router;
};

export const APPLICATION_DEPENDENCIES = [
  ...INFRASTRUCTURE_DEPENDENCIES,
  'service',
  'router',
] as const;

export function missingDependencies(
  candidates: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter((name) => {
    const value = candidates[name];
    return value === undefined || value === null;
  });
}

export function createDependencyContainer(parts: Partial<InfrastructureDependencies>): {
  dependencies: InfrastructureDependencies | null;
  missing: string[];
} {
  const missing = missingDependencies(
    parts as Record<string, unknown>,
    INFRASTRUCTURE_DEPENDENCIES,
  );
  if (missing.length > 0) {
    return { dependencies: null, missing };
  }
  return { dependencies: parts as InfrastructureDependencies, missing: [] };
}

export function createApplicationContainer(parts: Partial<ApplicationDependencies>): {
  dependencies: ApplicationDependencies | null;
  missing: string[];
} {
  const missing = missingDependencies(parts as Record<string, unknown>, APPLICATION_DEPENDENCIES);
  if (missing.length > 0) {
    return { dependencies: null, missing };
  }
  return { dependencies: parts as ApplicationDependencies, missing: [] };
}
