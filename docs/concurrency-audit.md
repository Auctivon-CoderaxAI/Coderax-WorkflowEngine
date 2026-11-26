# Concurrent-commit audit

Date: 2026-11-26. Branch: `feat/workflow-engine-foundation`.

## Why this document exists

Two engineering actors write to this branch: this agent, and CodeRabbit autofix.
Both used whole-file writes, so a commit based on a stale archive can silently
replace a file another actor changed in between. Passing tests do not prove that
did not happen. This document lists what each commit touched, what was
overwritten, and what was recovered.

## Commit sequence

| Commit | Actor | Subject |
| --- | --- | --- |
| `6603d25` | this agent | prior foundation head |
| `e0ec703` | CodeRabbit | bound cancellation cleanup; redact agent output before streaming/persistence |
| `a09ba16` | CodeRabbit | require TLS for remote MongoDB; fix lease updates; redact transcript credentials |
| `5692abe` | this agent | durable stores, bounded cancellation, live readiness |
| `7ee083b` | this agent | durable-store tests and matrix |
| `af8f487` | this agent | parity matrix |
| `5b5083e` | CodeRabbit | enforce MongoDB TLS from driver-parsed options; direct connection without TLS |
| this commit | this agent | restore the three runner behaviours the whole-file write replaced |

## Overlap and outcome

`5692abe` upserted whole files that `e0ec703` and `a09ba16` had changed:

| File | CodeRabbit change | Outcome |
| --- | --- | --- |
| `src/persistence/mongo-connect.ts` | TLS required for remote or discoverable connections, injected driver loader | **Replaced** by `5692abe`; re-applied by `5b5083e`. Present at HEAD. |
| `src/persistence/mongo.ts` | `includeResultMetadata: false` on every `findOneAndUpdate` | **Replaced**; re-applied by `5b5083e`. Present at HEAD. |
| `tests/fakes/mongo.ts` | reject `findOneAndUpdate` without the metadata flag | **Replaced** by `7ee083b`; re-applied by `5b5083e`. Present at HEAD. |
| `tests/unit/persistence-wiring.test.ts` | TLS matrix test | **Replaced** by `7ee083b`; re-applied by `5b5083e`. Present at HEAD. |
| `src/bootstrap/compose.ts` | persistence health detail said "leases only" | Replaced deliberately: after `5692abe` the statement was no longer true. Superseded, not lost. |
| `src/execution/runner.ts` | pre-aborted signal check; post-abort report gate; cancellation settles on throw | **Replaced and not re-applied by the bot.** Restored in this commit with two tests. |

Unaffected because this agent never wrote them: `src/orchestration/service.ts`,
`src/orchestration/transcript.ts`, `src/observability/redact.ts`,
`tests/integration/work.test.ts`, `tests/unit/transcript.test.ts`. Their tests
account for the difference between the 98 tests of `5692abe` and the 103 at
`5b5083e`.

## Recovery

`src/execution/runner.ts` restores the three lost behaviours:

1. `if (request.signal.aborted) onExternalAbort()` — a cancellation that races
   the start is honored instead of ignored.
2. A guarded report callback — nothing an adapter reports after the abort can
   reach the bus, independent of the service's own controller check.
3. A throw from an adapter that was aborted settles as `cancelled`, not
   `provider_error`. Retrying something the owner deliberately stopped is wrong.

`tests/unit/runner-abort.test.ts` covers (2) and (3) directly; the cancellation
and lost-lease cases in `tests/unit/runner.test.ts` still pass.

## Write protocol from here

The GitHub integration offers only whole-file upserts; it cannot apply a patch
or accept an expected HEAD. That is a property of the tool, not a choice, so the
protocol compensates:

1. Re-read the branch head immediately before writing; never reuse an archive
   fetched earlier in the session.
2. Change only files this agent owns in the current change; a file another actor
   touched is re-read at head first.
3. Commit one coherent set, then re-read the resulting head.
4. Verify the pushed commit from a clean clone (`npm ci && npm run verify`), not
   from the working copy that produced it.
5. Never force-push. A non-fast-forward refusal is a signal that another actor
   landed a commit: refetch, re-read the affected files, re-apply, and retry.
