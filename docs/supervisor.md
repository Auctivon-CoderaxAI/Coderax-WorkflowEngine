# The execution supervisor

Every tool-capable operation runs through `src/execution/supervisor.ts`. That
includes Work tasks and Chat turns. The guarantees below only hold if one
component owns the identity, the authority and the record of how an attempt
ended.

## Relationship to the task runner

The supervisor **wraps** the task runner; it does not replace it. `TaskRunner`
(`src/execution/runner.ts`) still owns the lease, the heartbeat, the cancellation
grace period, the adapter's abort signal and the fenced settlement contract —
those are the invariants in `AGENTS.md`, and a second implementation of them
would be a second terminal authority.

The supervisor supplies the `launch` callback that calls the runner and turns its
verdict into supervision data. In particular `RunResult.terminated` is the only
evidence this layer has that an adapter's promise really settled: `terminated:
false` becomes `abandoned`, which is recorded as `unverified` and holds the
workspace. The generation registry (token → task, generation, root) and the
durable attempt record (execution id) live in the same object, so a live run is
one token and one attempt and neither can outlive the other.

## What is enforced

**One durable identity per attempt.** An `executionId` names one run, not one
task. A resume, a retry and an approval each produce a new identity under a new
generation and fencing token. The record is written before the adapter starts and
is stored in `executions` (Mongo) or the process-local repository. Chat turns get
an identity too, with `taskId: null`, because a Chat turn can call tools and must
be revocable for the same reasons.

**Scoped authority, revoked at the boundary.** A grant names the scopes and the
resolved workspace root for exactly one execution. Revocation is synchronous:
after a cancel, an interruption or a shutdown, `guard.live()` is false and every
tool call is refused, including a call from an adapter that ignored its abort.
Resource matching resolves the path, so a relative resource is checked against
the root and `../` cannot escape it.

**Credentials are not part of the grant.** The engine keeps its own credentials
in its own process. A child process — a shell command or an external agent —
receives an allow-listed environment (`src/security/environment.ts`), never
`process.env`. `env -0` inside a supervised command cannot see an owner token, an
inference key or a database URI.

**Three distinct endings.**

| cause | who decided | task state | resumable |
| --- | --- | --- | --- |
| `cancelled` | the owner | `cancelled` | retry only |
| `interrupted` | lost authority (lease lapse, supersession, dead replica) | left untouched by that generation; reconciled to `interrupted` | yes |
| `shutdown` | the process is stopping | left untouched; reconciled at next startup | yes |
| `suspended` | an owner approval is pending | `awaiting_approval` | yes |
| `completed` / `failed` | the run itself | terminal | retry when retryable |

`interrupt` and `shutdown` deliberately write no terminal state: the newer
generation, or startup reconciliation, is the only writer.

**Supersession is explicit.** A newer generation of the same task is admitted
into the same workspace by interrupting the older attempt first; its capability
is revoked before the replacement starts. A different task in the same root is
refused with `workspace_busy`.

## Termination: what is verified and what is not

A resolved adapter promise proves that an async function returned. It does not
prove that a child process exited or that a remote workload stopped.

- `no-child-processes` is verified in-process: the tool broker observed every
  call and none could spawn a process.
- `process-group-exited` and `workload-destroyed` are only accepted from a
  workload-isolation provider that actually observed the workload.
- Everything else is `unverified` — `adapter_abandoned`,
  `descendants_unobservable` or `workload_isolation_unavailable`.

An execution with unverified termination leaves its workspace root **held** for
`execution.containmentHoldMs` (default 60 s). A new run in that root is refused
with `workspace_denied` rather than writing alongside code this process can no
longer observe. Shell commands run in their own process group so a cancel signals
descendants, but this is bounded containment, not a proof of termination.

## Capability report

`GET /v1/health` includes an optional `isolation` check. The same matrix is
available from `supervisor.isolation()`:

| capability | status | meaning |
| --- | --- | --- |
| filesystem | bounded | path confinement, not a syscall sandbox; chmod/rename cannot revoke an open descriptor |
| process | bounded | cancellation aborts and bounds the wait; descendants are not verifiably terminated |
| credentials | enforced | child processes get an allow-listed environment only |
| network | bounded | opt-in and host allow-listed; external egress is outside this process |
| cross-replica-containment | unavailable | holds and revocation are process-local; no shared-store coordination is verified |
| workload | unavailable | no DeploymentPlatformAI isolation integration is configured |

`DeploymentPlatformAI` plugs in through `WorkloadIsolationProvider`. The default
provider reports `available: false` and never verifies anything, so an
unavailable platform makes the engine more conservative: the attempt is recorded
unverified and the root is held. When such a provider is configured and can
observe a workload, `verifyTermination` may return `process-group-exited` or
`workload-destroyed`, and only then is the attempt recorded as verified.

## Non-claims

This module is **not** a syscall sandbox, a container runtime or a virtual
machine. Specifically:

- An in-process adapter executes JavaScript in the engine's own process. A
  permission check is not a kernel boundary.
- File permissions and renames do not revoke a file descriptor that is already
  open.
- Revoking a capability stops the next tool call; it cannot roll back a write
  that is already in flight.
- A workspace hold is process-local. It is **not** cross-replica containment.
  Another replica does not see it, and nothing here coordinates a shared
  filesystem. That row is reported as `unavailable`, not claimed.
- An external agent's process tree and credentials live outside this engine;
  their termination is unverified unless a provider says otherwise.

These limits are reported through the capability matrix rather than hidden behind
a stronger word.
