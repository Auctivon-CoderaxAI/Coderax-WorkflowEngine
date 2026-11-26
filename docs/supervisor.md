# The execution supervisor

Every tool-capable operation runs through `src/execution/supervisor.ts`. Work and
Chat share that path: an attempt has a durable identity, a revocable capability
grant and an explicit termination decision. The supervisor's fencing primitives
come from PR #5 (`feat/execution-supervisor` at `13d4b4f`); its process-local
workspace hold was replaced by the shared quarantine store described below.

## What is enforced

**One durable identity per attempt.** An `executionId` names one run, not one
task. A resume, retry or approval produces a new generation under a new fencing
token. The `executions` row is written before the adapter starts and is shared by
every replica, so which attempt ran and how it ended survives a restart.

**Scoped authority, revoked at the boundary.** A grant names the scopes and the
resolved workspace root for one execution. Cancellation, interruption and
shutdown abort the run and revoke the grant synchronously; an adapter that
ignores its abort cannot start another tool call through the broker.

**Three distinct endings.** Cancellation is the owner's decision and settles as
`cancelled`. Interruption means authority was lost: the attempt writes no terminal
task state and is resumable. Shutdown aborts active attempts without writing a
terminal state; startup reconciliation retires them. A duplicate execution
identity is refused before the adapter is called.

**Supersession is explicit.** A newer generation of the same task interrupts the
older attempt and revokes it before the replacement starts. The older run's report
channel is sealed by the task fencing token.

## Termination and durable quarantine

A resolved adapter promise is not evidence that a child process or remote workload
stopped. Only `no-child-processes` is verified in-process when the tool broker
observed every call and none could spawn a process. Everything else is
`unverified` unless a configured workload-isolation provider actually observed the
workload.

`unverified` is a first-class result, not an error. When the doubt is local — the
engine stopped waiting for the adapter, an in-process tool spawned a process, a
configured provider failed to verify, or startup retired an attempt whose owner
stopped heartbeating — the supervisor records the attempt as unverified and
writes a quarantine row for the workspace root:

- `quarantine` has a unique `root`, an `until` deadline, the execution id and the
  reason.
- Every replica consults that row before admitting an execution; a held root is
  refused with `workspace_denied`.
- The row is written before the in-process slot is released, so it exists even if
  the process dies immediately after settling.
- Expiry is enforced on read, so a replica that has not run its sweep cannot use a
  stale hold.
- Startup `retireStale` finishes attempts whose owner stopped heartbeating and
  writes the same durable hold, which makes crash recovery cross-replica.

A remote workload is different. An external agent runs on its own transport; when
that call returns, its process is not something this engine owns or can contain by
refusing a local directory. With no isolation provider configured such an attempt
is recorded `unverified`, but no hold is written: holding the shared root would
refuse every later Work and Chat run for the hold window without containing
anything. The adapter's abandonment is still local — an external run the engine
stopped waiting for holds the root like any other.

This is held in `quarantine` (Mongo) or the process-local table when
`persistence.driver=memory`. With the memory driver it is not cross-replica, and
the capability report says so.

## Capability report

`GET /v1/ready` includes an `execution.supervisor` probe. The same matrix is
available from `supervisor.isolation()`:

| capability | status | meaning |
| --- | --- | --- |
| filesystem | bounded | path confinement, not a syscall sandbox |
| process | bounded | cancellation aborts and bounds the wait; descendants are not verifiably terminated |
| credentials | enforced | child processes receive an allow-listed environment only |
| network | bounded | network access is opt-in and host allow-listed |
| quarantine | enforced | unverified local termination holds the root for every replica |
| cross-replica-containment | bounded | quarantine is shared; live capability revocation is process-local |
| workload | unavailable | no deployment-platform isolation provider is configured |

`cross-replica-containment` is deliberately not `enforced`: the capability broker
that revokes an in-flight attempt lives in one process. The durable quarantine
bounds what a replacement replica may do, but it does not prove that another
replica's live adapter has stopped.

## Non-claims

- This is not a syscall sandbox or a container runtime.
- Revoking a capability stops the next tool call; it cannot roll back an in-flight
  write.
- An external agent's process tree lives outside this engine; its termination is
  unverified unless a provider reports otherwise.
