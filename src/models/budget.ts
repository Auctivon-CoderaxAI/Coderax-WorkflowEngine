import { randomUUID } from 'node:crypto';
import type { Usage } from '@coderax/contracts';

/**
 * The zero-cost budget is a reservation ledger, not a warning counter.
 *
 * A request reserves one request slot and an estimated input+output token
 * allowance before the provider is called. The reservation is a durable record,
 * not a number in a closure, because the process that reserved the allowance may
 * crash, the next attempt may arrive on another replica, and a provider may
 * consume inference for a request whose response never arrived.
 *
 * There is exactly one ledger implementation. Only the store underneath it
 * differs: `createMemoryBudgetStore` is process-local and loses everything on
 * restart, while the MongoDB store in `src/persistence/budgets.ts` arbitrates
 * reservations between replicas with a conditional atomic update.
 *
 * Accounting rules, each chosen so uncertainty is charged rather than refunded:
 *
 * - An attempt that never reached the provider releases its whole reservation.
 * - An attempt that may have reached it (`dispatched`) settles at the reserved
 *   amount. A provider timeout, a dropped stream or a missing usage report is
 *   ambiguous, and releasing the allowance would let a failing provider consume
 *   an unbounded number of requests while the local ledger reported zero.
 * - A provider that reports more usage than was reserved is charged the reported
 *   amount. The window may then exceed its ceiling, which refuses the next
 *   request instead of hiding the overrun.
 * - Settlement and release are idempotent: the reservation row flips once, so a
 *   retry, a duplicate resume or two replicas settling concurrently cannot
 *   charge or refund the same allowance twice.
 * - A reservation that is never settled expires. The sweep refunds it exactly
 *   once, so a crashed process cannot hold the day's allowance forever.
 * - A settlement is charged to the UTC day the reservation was made in, so a
 *   request that spans midnight is not counted on two days.
 */

export type BudgetReservation = {
  id: string;
  ownerId: string;
  /** The task this reservation belongs to, when the request is task-scoped. */
  taskId: string | null;
  inputTokens: number;
  outputTokens: number;
};

export type BudgetWindow = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Reserved but not yet settled tokens; they still count against the day. */
  reservedTokens: number;
};

export type BudgetSnapshot = BudgetWindow;

export type BudgetRefusalReason =
  | 'requests'
  | 'tokens'
  | 'task_requests'
  | 'task_tokens';

export type ReserveOutcome =
  | { allowed: true; reservation: BudgetReservation; requests: number }
  | {
      allowed: false;
      reason: BudgetRefusalReason;
      detail: string;
      requests: number;
    };

/**
 * The durable port. One call either takes a slot under the ceiling or reports
 * the window that refused it; there is no read-then-write in the ledger, so two
 * callers cannot both observe the same remaining allowance.
 */
export type BudgetStore = {
  reserve: (input: {
    id: string;
    key: string;
    taskKey: string | null;
    maxRequests: number;
    maxTokens: number;
    taskMaxRequests: number;
    taskMaxTokens: number;
    inputTokens: number;
    outputTokens: number;
    expiresAt: string;
    now: Date;
  }  ) => Promise<
    | {
        allowed: true;
        reservationId: string;
        window: BudgetWindow;
        taskWindow: BudgetWindow | null;
      }
    | { allowed: false; reason: BudgetRefusalReason; window: BudgetWindow }
  >;
  /** Charge actual usage for the reservation, or the reserved amount when the report is missing. */
  settle: (input: { id: string; usage: Usage; now: Date }) => Promise<void>;
  /** Refund an undispatched reservation, or settle it at the reserved amount. */
  release: (input: { id: string; dispatched: boolean; now: Date }) => Promise<void>;
  /** Charge work that bypassed the router, such as an external engine. */
  charge: (input: {
    key: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    now: Date;
  }) => Promise<void>;
  read: (key: string) => Promise<BudgetWindow>;
};

export type BudgetLedger = {
  available: (ownerId: string, at: Date, taskId?: string | null) => Promise<boolean>;
  reserve: (input: {
    ownerId: string;
    at: Date;
    inputTokens: number;
    outputTokens: number;
    taskId?: string | null;
  }) => Promise<ReserveOutcome>;
  settle: (reservationId: string, usage: Usage) => Promise<void>;
  /**
   * Release an unspent reservation. `dispatched` marks an attempt that may
   * already have reached the provider: its request slot stays charged and its
   * token allowance settles at the reserved amount rather than being refunded.
   */
  release: (reservationId: string, options?: { dispatched?: boolean }) => Promise<void>;
  charge: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  /**
   * Record token usage for a run whose request slot was already charged at
   * admission. It must not charge a second request.
   */
  recordUsage: (ownerId: string, usage: Usage, at: Date) => Promise<void>;
  snapshot: (ownerId: string, at: Date, taskId?: string | null) => Promise<BudgetSnapshot>;
};

export type BudgetSettings = {
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  /** A single task may never consume the whole owner allowance. */
  taskMaxRequests: number;
  taskMaxTokens: number;
  /** After this, an unsettled reservation is refunded by the next reservation. */
  reservationTtlMs?: number;
};

export function budgetKey(ownerId: string, at: Date): string {
  return `${ownerId}:${at.toISOString().slice(0, 10)}`;
}

export function budgetTaskKey(ownerId: string, taskId: string, at: Date): string {
  return `${ownerId}:${taskId}:${at.toISOString().slice(0, 10)}`;
}

const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1_000;

export function createBudgetLedger(input: {
  store: BudgetStore;
  maxRequestsPerDay: number;
  maxTokensPerDay: number;
  taskMaxRequests: number;
  taskMaxTokens: number;
  reservationTtlMs?: number;
  id?: () => string;
}): BudgetLedger {
  const ttl = Math.max(60_000, input.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS);
  const newId = input.id ?? (() => `budget_${randomUUID()}`);

  function clampTokens(value: number): number {
    return Math.max(0, Math.ceil(Number.isFinite(value) ? value : 0));
  }

  return {
    available: async (ownerId, at, taskId) => {
      const window = await input.store.read(budgetKey(ownerId, at));
      if (window.requests + window.reservedTokens === 0) {
        // Nothing has been recorded yet, so the day is intact.
        return true;
      }
      const tokensUsed = window.inputTokens + window.outputTokens + window.reservedTokens;
      if (tokensUsed >= input.maxTokensPerDay) return false;
      if (window.requests >= input.maxRequestsPerDay) return false;
      if (taskId === undefined || taskId === null) return true;
      const task = await input.store.read(budgetTaskKey(ownerId, taskId, at));
      return (
        task.requests < input.taskMaxRequests &&
        task.inputTokens + task.outputTokens + task.reservedTokens < input.taskMaxTokens
      );
    },

    reserve: async ({ ownerId, at, inputTokens, outputTokens, taskId }) => {
      const inTokens = clampTokens(inputTokens);
      const outTokens = clampTokens(outputTokens);
      const key = budgetKey(ownerId, at);
      const scopedTaskId = taskId ?? null;
      const outcome = await input.store.reserve({
        id: newId(),
        key,
        taskKey: scopedTaskId === null ? null : budgetTaskKey(ownerId, scopedTaskId, at),
        maxRequests: input.maxRequestsPerDay,
        maxTokens: input.maxTokensPerDay,
        taskMaxRequests: input.taskMaxRequests,
        taskMaxTokens: input.taskMaxTokens,
        inputTokens: inTokens,
        outputTokens: outTokens,
        expiresAt: new Date(at.getTime() + ttl).toISOString(),
        now: at,
      });
      if (!outcome.allowed) {
        return {
          allowed: false,
          reason: outcome.reason,
          detail: refusalDetail(outcome.reason),
          requests: outcome.window.requests,
        };
      }
      return {
        allowed: true,
        reservation: {
          // The id is the store's reservation identity; it is returned through
          // the outcome so the router settles exactly the row it created.
          id: outcome.reservationId,
          ownerId,
          taskId: scopedTaskId,
          inputTokens: inTokens,
          outputTokens: outTokens,
        },
        requests: outcome.window.requests,
      };
    },

    settle: async (reservationId, usage) => {
      // A settlement with no reported usage is not proof that nothing was spent.
      // The reservation becomes the charge, exactly as a dispatched release does.
      if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
        await input.store.release({ id: reservationId, dispatched: true, now: new Date() });
        return;
      }
      await input.store.settle({ id: reservationId, usage, now: new Date() });
    },

    release: async (reservationId, options = {}) => {
      await input.store.release({
        id: reservationId,
        dispatched: options.dispatched === true,
        now: new Date(),
      });
    },

    charge: async (ownerId, usage, at) => {
      await input.store.charge({
        key: budgetKey(ownerId, at),
        requests: 1,
        inputTokens: clampTokens(usage.inputTokens ?? 0),
        outputTokens: clampTokens(usage.outputTokens ?? 0),
        now: at,
      });
    },

    recordUsage: async (ownerId, usage, at) => {
      await input.store.charge({
        key: budgetKey(ownerId, at),
        requests: 0,
        inputTokens: clampTokens(usage.inputTokens ?? 0),
        outputTokens: clampTokens(usage.outputTokens ?? 0),
        now: at,
      });
    },

    snapshot: async (ownerId, at) => input.store.read(budgetKey(ownerId, at)),
  };
}

/**
 * Admission hold for callers that only need a request slot. The router uses the
 * full reservation API; orchestration admission has no token estimate yet, so it
 * holds the slot and releases it if the run is refused before execution.
 */
export type BudgetHold =
  | {
      allowed: true;
      reservationId: string;
      /** Charge the slot for an attempt that was dispatched. */
      commit: () => Promise<void>;
      /** Return the slot because nothing was dispatched. */
      release: () => Promise<void>;
    }
  | { allowed: false; reason: BudgetRefusalReason; detail: string };

export async function holdBudget(
  ledger: BudgetLedger,
  ownerId: string,
  at: Date,
): Promise<BudgetHold> {
  const outcome = await ledger.reserve({ ownerId, at, inputTokens: 0, outputTokens: 0 });
  if (!outcome.allowed) {
    return { allowed: false, reason: outcome.reason, detail: outcome.detail };
  }
  let held = true;
  return {
    allowed: true,
    reservationId: outcome.reservation.id,
    commit: async () => {
      if (!held) return;
      held = false;
      await ledger.release(outcome.reservation.id, { dispatched: true });
    },
    release: async () => {
      if (!held) return;
      held = false;
      await ledger.release(outcome.reservation.id);
    },
  };
}

function refusalDetail(reason: BudgetRefusalReason): string {
  switch (reason) {
    case 'requests':
      return 'The daily zero-cost request budget is exhausted.';
    case 'tokens':
      return 'The daily zero-cost token budget cannot cover this request.';
    case 'task_requests':
      return 'This task has used its request allowance for today.';
    case 'task_tokens':
      return 'This task has used its token allowance for today.';
  }
}

/**
 * The process-local store. It implements exactly the durable store's contract so
 * tests and single-process deployments exercise the same ledger, but it keeps
 * nothing across a restart and arbitrates nothing between replicas. A production
 * deployment that needs either property selects `persistence.driver=mongo`.
 */
export function createMemoryBudgetStore(): BudgetStore {
  type Window = {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    reservedTokens: number;
  };
  type Reservation = {
    id: string;
    key: string;
    taskKey: string | null;
    inputTokens: number;
    outputTokens: number;
    expiresAt: number;
    settled: boolean;
  };

  const windows = new Map<string, Window>();
  const reservations = new Map<string, Reservation>();

  function window(key: string): Window {
    const existing = windows.get(key);
    if (existing) return existing;
    const created: Window = { requests: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0 };
    windows.set(key, created);
    return created;
  }

  function committed(state: Window): number {
    return state.inputTokens + state.outputTokens + state.reservedTokens;
  }

  function copy(state: Window): BudgetWindow {
    return {
      requests: state.requests,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      reservedTokens: state.reservedTokens,
    };
  }

  function expire(now: Date): void {
    for (const reservation of reservations.values()) {
      if (reservation.settled || reservation.expiresAt > now.getTime()) continue;
      reservation.settled = true;
      const tokens = reservation.inputTokens + reservation.outputTokens;
      const owner = windows.get(reservation.key);
      if (owner) {
        owner.requests = Math.max(0, owner.requests - 1);
        owner.reservedTokens = Math.max(0, owner.reservedTokens - tokens);
      }
      const task = reservation.taskKey === null ? null : windows.get(reservation.taskKey);
      if (task) {
        task.requests = Math.max(0, task.requests - 1);
        task.reservedTokens = Math.max(0, task.reservedTokens - tokens);
      }
      reservations.delete(reservation.id);
    }
  }

  function take(
    key: string,
    maxRequests: number,
    maxTokens: number,
    tokens: number,
    kind: 'requests' | 'tokens' | 'task_requests' | 'task_tokens',
  ): { ok: true } | { ok: false; reason: BudgetRefusalReason } {
    const state = window(key);
    if (state.requests >= maxRequests) return { ok: false, reason: kind === 'task_requests' ? 'task_requests' : 'requests' };
    // No headroom is not the same as enough room: once the ceiling is reached,
    // even a zero-token reservation is refused because the request will spend
    // tokens the ledger has already promised elsewhere.
    if (committed(state) >= maxTokens) {
      return { ok: false, reason: kind === 'task_tokens' ? 'task_tokens' : 'tokens' };
    }
    if (committed(state) + tokens > maxTokens) return { ok: false, reason: kind === 'task_tokens' ? 'task_tokens' : 'tokens' };
    state.requests += 1;
    state.reservedTokens += tokens;
    return { ok: true };
  }

  function untake(key: string, tokens: number, requests: number): void {
    const state = windows.get(key);
    if (!state) return;
    state.requests = Math.max(0, state.requests - requests);
    state.reservedTokens = Math.max(0, state.reservedTokens - tokens);
  }

  function chargeWindow(key: string, requests: number, inputTokens: number, outputTokens: number): void {
    const state = window(key);
    state.requests += requests;
    state.inputTokens += inputTokens;
    state.outputTokens += outputTokens;
  }

  return {
    reserve: async (request) => {
      expire(request.now);
      const tokens = request.inputTokens + request.outputTokens;
      // `take` records the split on the reservation, so the total is derived.
      void tokens;
      const owner = take(request.key, request.maxRequests, request.maxTokens, tokens, 'requests');
      if (!owner.ok) return { allowed: false, reason: owner.reason, window: copy(window(request.key)) };
      if (request.taskKey !== null) {
        const task = take(
          request.taskKey,
          request.taskMaxRequests,
          request.taskMaxTokens,
          tokens,
          'task_requests',
        );
        if (!task.ok) {
          untake(request.key, tokens, 1);
          return { allowed: false, reason: task.reason, window: copy(window(request.key)) };
        }
      }
      reservations.set(request.id, {
        id: request.id,
        key: request.key,
        taskKey: request.taskKey,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        expiresAt: Date.parse(request.expiresAt),
        settled: false,
      });
      return {
        allowed: true,
        reservationId: request.id,
        window: copy(window(request.key)),
        taskWindow: request.taskKey === null ? null : copy(window(request.taskKey)),
      };
    },

    settle: async ({ id, usage }) => {
      // Settling never expires: a provider can answer after the TTL, and the
      // sweep belongs to admission, not to the response that closes the row.
      const reservation = reservations.get(id);
      if (!reservation || reservation.settled) return;
      reservation.settled = true;
      reservations.delete(id);
      const input = Math.max(0, usage.inputTokens ?? reservation.inputTokens);
      const output = Math.max(0, usage.outputTokens ?? reservation.outputTokens);
      for (const key of [reservation.key, reservation.taskKey]) {
        if (key === null) continue;
        const state = window(key);
        state.reservedTokens = Math.max(
          0,
          state.reservedTokens - reservation.inputTokens - reservation.outputTokens,
        );
        state.inputTokens += input;
        state.outputTokens += output;
      }
    },

    release: async ({ id, dispatched }) => {
      const reservation = reservations.get(id);
      if (!reservation || reservation.settled) return;
      reservation.settled = true;
      reservations.delete(id);
      const tokens = reservation.inputTokens + reservation.outputTokens;
      if (!dispatched) {
        untake(reservation.key, tokens, 1);
        if (reservation.taskKey !== null) untake(reservation.taskKey, tokens, 1);
        return;
      }
      // The attempt may have reached the provider. Charge the reserved amount
      // rather than refunding allowance that could already have been consumed.
      for (const key of [reservation.key, reservation.taskKey]) {
        if (key === null) continue;
        const state = window(key);
        state.reservedTokens = Math.max(0, state.reservedTokens - tokens);
        state.inputTokens += reservation.inputTokens;
        state.outputTokens += reservation.outputTokens;
      }
    },

    charge: async ({ key, requests, inputTokens, outputTokens }) => {
      chargeWindow(key, requests, inputTokens, outputTokens);
    },

    read: async (key) => copy(window(key)),
  };
}
