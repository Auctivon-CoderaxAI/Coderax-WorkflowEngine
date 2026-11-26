# Security remediation: revalidation and evidence

Target: `main` (`808dfd3`) plus the two in-flight branches that change the
execution and inference seams — `feat/durable-events-integration` and
`feat/zero-cost-model-router`. Both merged without a source conflict. The branch
is `security/remediation`.

`feat/intelligence-core` and `feat/native-reasoning-planner` were inspected and
**not merged** at the time (PR #5 has since reconciled them; see the
coordination section). Intelligence Core adds a second model router (`src/models/router.ts`
with the same exported names as the verified router), a tool loop and a different
gateway contract; landing both routers would leave two authorities for one
decision, which `AGENTS.md` forbids. Its findings are recorded at the end as
follow-ups, not silently claimed as fixed.

Baseline reproduction was executed, not inferred: a clean worktree at `808dfd3`
(`npm ci && npm run build`) ran the script preserved at
`docs/evidence/baseline-808dfd3-repro.mjs` against the real services and gateway
ports. Every result below was `true` on the baseline, meaning the defect was
present; the corresponding regression test is green at the pushed head.

```
{
  "A_private_conversation_crossed_into_cloud": true,
  "B_private_task_sent_to_hosted_gateway": true,
  "C_requireApproval_agent_ran_without_grant": true,
  "D_reply_contains_credential": true,
  "D_reply_contains_home_path": true,
  "E_two_conversations_share_one_workspace": true
}
```

## Findings and disposition

### 1. Private/cloud conversation isolation — fixed

**Path:** `src/persistence/conversations.ts`, `src/persistence/mongo-tables.ts`,
`src/orchestration/service.ts`.

`ensure` returned an existing conversation whenever the owner matched. It ignored
the data mode and the kind of work, so a private conversation supplied as the
`conversationId` of a cloud task was reused: the private transcript became the
cloud run's history and the cloud answer was appended to it. The Mongo and memory
implementations had the same hole.

Now the repository refuses a collision on owner, `mode` or `isWork` with a typed
`ConversationConflictError`, and the service maps it to `not_found` (foreign
owner) or `conflict` (mode/kind) before any task is created. One owner cannot
confirm another owner's conversation exists.

**Regression test:** `tests/security/remediation.test.ts` — “a conversation is
never reused across data modes”.

### 2. External agents received the transcript — fixed

**Path:** `src/orchestration/service.ts`.

Every agent was given `historyFor(conversationId, objective)`, although an
external agent's descriptor says `conversations: none`. The transcript was handed
to the injected transport.

History is now built only for `coderax`. An external agent receives the objective
and nothing else, in both `submitWork` and `chat`.

**Regression test:** “an external agent is never given the conversation
transcript”.

### 3. Unauthorized hosted inference in private mode — fixed

**Path:** `src/models/router.ts`, `src/models/types.ts`, `src/bootstrap/compose.ts`,
`src/security/endpoint.ts`.

`resolve` and `plan` accepted a data mode and never read it. A private task was
routed to whatever the zero-cost route selected, including a remote provider, so
private data left the machine.

Providers now carry `hosting`, derived from the parsed endpoint (`local` only for
loopback). `eligible`, the pinned-model path of `plan`, and `resolve` refuse a
hosted provider when the mode is `private` with `model_missing`; the request is
never sent. An injected adapter defaults to `local` because it runs in-process;
every real registration is classified from its URL.

**Regression test:** “private execution refuses a hosted inference endpoint”.

### 4. Plaintext and credential-bearing endpoints — fixed

**Path:** `src/configuration/schema.ts`, `src/bootstrap/compose.ts`,
`src/security/endpoint.ts`.

`baseURL` fields used `z.string().url()`, so `http://api.provider.com` was
accepted and the bearer key would cross the network in cleartext. A URL with
`user:password@` would also land in logs and error text.

A shared `SecureEndpoint` rule requires `https` unless the host is loopback
(`127.0.0.0/8`, `::1`, `localhost`), and rejects embedded credentials, a query or
a fragment. It applies to model providers, OpenCode and FreeBuff. The
unvalidated `CODERAX_INFERENCE_BASE_URL` environment variable is checked with the
same function in the composition root, and an unsafe value is a startup error.

**Regression test:** “an inference endpoint that would leak a credential is
refused at startup”.

### 5. Credential leakage through replies, notifications and stored rows — fixed

**Path:** `src/orchestration/service.ts`.

Redaction covered streamed event text and `toStatus`, but three paths bypassed it:
the chat reply and the assistant message stored from it, the completion
notification summary, and the failure detail persisted on the task row. Provider
or adapter text could carry a key or an owner path into all three.

`chat` scrubs the summary and the failure detail before storing or returning them.
`notifyTerminal` scrubs the summary. `settle` scrubs the failure detail before the
fenced write, so a reader of the row does not depend on a later projection.

**Regression test:** “provider text is scrubbed before it is stored, returned or
notified”.

### 6. Workspace confinement — fixed

**Path:** `src/execution/workspace.ts`, `src/orchestration/service.ts`.

Every conversation in a mode received the mode root as its workspace. Two runs
could read each other's files, a resume could not be told apart from an unrelated
conversation, and the supervisor's quarantine had to take the whole mode out of
service.

`resolveConversationWorkspace` derives `<modeRoot>/conversations/<sha256(id)>`
inside the mode root from the conversation id (never from a request path), creates
it `0700`, resolves it again through `realpath` and rejects anything that escapes
the root. It is per conversation, not per generation, so a resume continues in the
directory the previous generation wrote. Quarantine entries are now scoped to that
directory: the abandoned conversation is refused at submit and at start, while
other conversations continue.

The supervisor remains the only quarantine authority; this change supplies the
subdirectory it manages, it does not add a second one.

**Regression test:** “each conversation has its own confined workspace and a
resume reuses it”; the cancellation test in `tests/integration/work.test.ts` now
asserts the refusal at submit and that another conversation is unaffected.

### 7. Abandoned execution — resolved by the merged supervisor, verified

**Path:** `src/execution/quarantine.ts`, `src/execution/runner.ts`,
`src/bootstrap/compose.ts`.

`feat/durable-events-integration` registers `onAbandoned`, poisons the workspace
for `cancelQuarantineMs` and reports it in health. The runner seals the report
channel and stops heartbeating after the grace period. This branch only scopes the
poisoned root (finding 6) and verifies the behaviour end to end.

**Regression tests:** `tests/unit/events-durable.test.ts` — “a quarantined
workspace refuses new work until it expires or is released”;
`tests/integration/work.test.ts` — “cancellation releases a hung adapter and
ignores its late reports”.

### 8. Stale-generation activity — resolved by the merged supervisor, verified

**Path:** `src/events/log.ts`, `src/persistence/mongo-events.ts`,
`src/events/bus.ts`.

The durable log stores the highest generation per task and refuses an append from
an older one; the Mongo head advances with `$max`, so a stale replica cannot lower
it. A terminal task whose stream lost its terminal event is repaired from the task
row, never the reverse.

**Regression tests:** `tests/unit/events-durable.test.ts` — “a stale generation
cannot append to a stream a newer generation owns”, plus the duplicate and
out-of-order cases.

### 9. Permission enforcement — fixed

**Path:** `src/permissions/store.ts`, `src/orchestration/service.ts`,
`src/persistence/tasks.ts`, `src/persistence/mongo-tables.ts`.

`requireApproval` was recorded and never consulted. An external agent — which
declares tool capability it executes outside this process — ran immediately, so
the owner's "approve before it acts" was decorative. Decisions were also mutable
(a denied request could be flipped to approved), expired requests still counted as
pending, and nothing consumed a grant.

Now an external agent's run is gated when `requireApproval` is true: without a
grant the task is parked in `awaiting_approval`, a `command.execute` request bound
to the task id is created and published, the lease is released, and no dispatch
happens. The owner's decision is written durably on the task row
(`recordApproval`); a resume consumes it exactly once (`consumeApproval`) before
the run starts. A denial never dispatches, and the owner may reconsider through a
new request. A spent grant cannot be replaced, so it cannot authorize a second
run. A suspended task can now be cancelled without a live lease, and a terminal
task's permissions cannot change.

**Regression tests:** “an autonomous external agent runs only with a durable,
single-use grant”; `tests/unit/mongo-stores.test.ts` — “an owner decision is
durable and a grant is consumed exactly once”.

### 10. Secret redaction — fixed

Covered by finding 5, plus the pre-existing scrub of streamed text, tool input and
output, approval descriptions and `toStatus`. The configured-secret list remains
empty at the boundary because no value is read into configuration; the patterns
cover bearer tokens, provider keys, GitHub tokens, JWTs, query credentials,
`key=value` secrets and home paths.

### 11. Persistent security state — fixed for approvals

**Path:** `src/domain.ts`, `src/persistence/tasks.ts`,
`src/persistence/mongo-tables.ts`.

A permission decision lived only in a process-local map, so a restart lost the
grant and left an `awaiting_approval` task with nothing to approve. The decision
and its single-use consumption are now fields on the durable task row, written
with conditional updates (non-terminal, not already spent). The in-process request
list is only the prompt; a restart re-issues a pending request on the next resume
and the recorded decision still authorizes exactly one run.

**Remaining limitation:** the daily zero-cost budget ledger
(`src/models/budget.ts`) is still process-local. A restart resets the counters, so
a deployment that restarts mid-day can exceed its self-imposed free-tier ceiling
before the provider does. The provider's own quota and the circuit breaker remain
the backstop, and no paid route exists. Persisting the ledger needs an atomic
reserve across replicas and is recorded as follow-up rather than half-implemented.

### 12. Dependency vulnerability: zod — verified, mitigated, not upgraded

**Advisory:** GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404, “Zod can exhaust memory while
validating oversized constrained collections”. GitHub reviewed it on 2026-10-23
and lists **affected `< 4.6.6`, patched `4.6.6`** (CVSS 7.5 v3.1 / 8.2 v4,
CWE-770). `npm audit` proposes `4.6.7` because that is the latest release, not
because the advisory names it.

Facts that decide the response:

- The underlying CVE was rejected by its CNA on 2026-10-28; the GitHub advisory
  still marks every release below 4.6.6 as affected.
- The fix in 4.6.6 makes `.max()`, `.length()` and `.size()` reject an oversized
  container **before** parsing elements. The advisory's own scope is “an array
  schema without a length constraint”; the release notes state that unbounded
  containers are unchanged.
- There is no 3.x release with the fix and none is planned. This repository is on
  `zod@3.25.76`, which the advisory range includes.

Reachability in this target: no HTTP request schema has an unbounded array. The
only request array is `NotificationReadRequest.taskIds` (1–100), and the 1 MiB
transport cap bounds any body. Zod 3 still validates elements before applying
`.max()`, so a body with hundreds of thousands of entries could allocate an issue
per element even though the schema would reject it.

Response: the body guard in `src/api/router.ts` refuses a JSON array longer than
256 entries (and nesting deeper than 8) **before** schema validation, which
removes the amplification regardless of zod version — the 4.6.6 fix does not
protect unbounded containers either. A 4.6.6 upgrade would therefore not change
this exposure, while forcing a major migration of `packages/contracts` (the
`_def.typeName` walk in `json-schema.ts`, `.strict()` object semantics, record
signatures) and a regeneration of `openapi.json` and the SDK. Per the brief, the
dependency is not updated merely to clear an audit line.

**Residual risk:** `npm audit` still reports one high advisory for zod 3. It is
documented here rather than suppressed, and it is not exploitable through this
engine's ingress after the guard. When the contracts package migrates to zod 4 for
other reasons, 4.6.6 is the correct minimum, verified against the advisory rather
than assumed from the suggested `4.6.7`.

**Regression test:** “an oversized request array is refused before schema
validation”.

## Findings inspected in unmerged branches (not fixed here)

These are recorded so the next integration does not inherit them silently.

| Branch | Finding | Why not fixed here |
| --- | --- | --- |
| `feat/intelligence-core` | A second `src/models/router.ts` and `src/models/routed.ts` duplicate the verified router's exported names and gateway contract. | Two authorities for one routing decision. The verified router must win; the branch needs a rebase that deletes its copy and adapts its call sites. |
| `feat/intelligence-core` | Tool approvals are persisted in a separate store; the tool runtime gates on the in-memory request, so a restart between decision and action loses the grant. | Depends on the tool lane, which is not on this target. `recordApproval`/`consumeApproval` here are the shape that lane should reuse. |
| `feat/intelligence-core` | `src/tools/paths.ts` adds a second path-confinement authority. | The supervisor owns workspace confinement; a tool must consume `request.workspaceRoot`, not re-derive it. |
| `feat/native-reasoning-planner` | `src/permissions/gate.ts` adds another approval gate. | Same reason: one permission authority. |
| `feat/durable-events` | Carries the durable-events change only as base64 snapshots. | Superseded by the reconciled `feat/durable-events-integration`. |

## Verification at the pushed head

```
npm ci
npm run verify
→ build 0, 162/162 tests, openapi.json matches the published contracts
```

Baseline evidence: the worktree at `808dfd3` printed the six `true` results above
before the fix; the same behaviours are asserted and green at this head.

## Coordination with concurrent work (2026-11-26)

The two active pull requests advanced past the tips merged here while this branch
was being verified. They now carry overlapping fixes, so this branch must not
merge ahead of them and is not a competing authority.

| Active branch | Head | Overlap with this branch |
| --- | --- | --- |
| `feat/zero-cost-model-router` (PR #4) | `1cd780d` | `src/models/policy.ts` adds a required per-operation data-processing policy. It is **stronger** than the hosting check in finding 3: private mode denies every hosted provider unless an exact owner grant with location, retention and training terms exists. It also hardens budget accounting and provider boundaries, and adds `tests/unit/policy.test.ts` and `tests/security/isolation.test.ts`. |
| `feat/execution-supervisor` (PR #5) | `13d4b4f` | Its own `src/security/endpoint.ts` (`credentialEndpoint`), persisted action-bound approvals, external-agent history isolation, tool-approval consumption, supervisor admission and workspace admission. This overlaps findings 2, 4, 5, 9 and 11, and adds a second endpoint helper at the same path as this branch's. |
| `feat/intelligence-core` (PR #2), `feat/native-reasoning-planner` (PR #3) | | PR #5 reconciled them (`e02c217`); its head is the current integration point for that work. |

What this means for a rebase:

- Where the active PRs implement a stronger rule, theirs wins. The
  policy registry (PR #4) replaces the hosting check; the supervisor's
  atomic admission replaces the mode-root directory handing; PR #5's
  `credentialEndpoint` must be the single endpoint helper, extended with the
  embedded-credential, query and fragment rejection (and applied to config
  `baseURL` fields) rather than kept as a second function.
- Genuine deltas that survive a rebase: the conversation owner/mode/kind
  identity check (finding 1), the per-conversation workspace directory consumed
  by the supervisor's quarantine (finding 6), the pre-validation JSON body bound
  and the zod analysis (finding 12), and the baseline reproduction in this
  document with its regression suite.
- The branches are mergeable individually against `main` but not verified
  against each other; PR #4 rewrites `src/models/router.ts` while PR #5 also
  touches it. The merge order is the owner's decision, and this branch should be
  rebased after both rather than merged first.
- No duplicate pull request was opened for this work; PR #4 and PR #5 already
  own most of these fixes, and `AGENTS.md` forbids duplicate PRs. The pushed
  branch is the evidence and the rebase base, not a merge candidate on its own.

## Limitations

- No live MongoDB was contacted. Durability is proven against the
  semantics-faithful collection fake, including unique indexes, dotted updates and
  conditional approval consumption.
- The budget ledger is process-local (finding 11).
- `npm audit` still lists the zod advisory (finding 12), by decision.
- Hosted CI did not run for this head; see the pull request for the executed
  command and its exact output.
- An independent review is required before merge and was not fabricated here.
