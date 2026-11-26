# Restore and reconciliation: verified result

This file records what was actually executed, not what was intended. It
supersedes the open question in `RECONCILIATION.md`; that file still describes
the conflict correctly, and this one records its resolution.

## 1. Restore from the snapshot

- Base archive fetched at the exact commit `51fd4ba`.
- `pending.patch` applied to it with **zero rejects**.
- All **20/20** manifest sha256 values verified (`sha256sum -c`).
- `npm ci && npm run verify` on that tree: **111/111 tests, 0 fail**,
  `openapi.json matches the published contracts`, exit 0.

The 20-file index is complete: the tree builds and the whole suite runs from it,
so no required source, test, contract or configuration file is missing. The
earlier "23 changed files" count included `docs/concurrency-audit.md`, which was
already published separately as `f170797`, and derived build output under
`dist/`. That is an inference from what the snapshot reproduces, not a
byte-level proof of the old working directory.

## 2. PR head

Fetched, not assumed: PR #1 head is `a95e4bb` (pushed 07:20Z), 15 commits,
110 changed files, `mergeable: true`, `mergeable_state: unstable`, 0 approvals.

## 3. Reconciliation onto `a95e4bb`

A three-way merge (ours `a95e4bb`, base `51fd4ba`, theirs snapshot) produced
exactly **two conflicts, both in `settle()`** in
`src/orchestration/service.ts`. Every other hunk applied cleanly.

Resolution, in order of the merged code:

1. CodeRabbit's terminal publish stays first, inside the `try`.
2. The snapshot's second fence is re-expressed as a token re-check before the
   transcript append; a superseded run returns without appending.
3. CodeRabbit's `.catch(() => undefined)` on `appendMessage` and
   `notifyTerminal` is kept, as is the single unified audit record.
4. The snapshot's flush barrier moves into CodeRabbit's `finally`, immediately
   before `releaseLease`, so the terminal event is durable before the lease can
   be reissued.
5. The snapshot's trailing duplicate `releaseLease` is dropped; `finally` owns
   the release.

CodeRabbit semantics preserved and confirmed present: try/finally lease release,
retry and resume `text.replace { text: '' }`, `checkpoint.text` reset in
`reissue` (both `mongo-tables.ts` and `tasks.ts`), settlement ordering,
transcript/notification failure handling, credential redaction, cancellation.

Verification of the merged tree: **114/114 tests, 0 fail**, OpenAPI clean,
exit 0. That is 111 from the snapshot plus the 3 tests `a95e4bb` adds.

## 4. Reconciled tree checksums

19 of the 20 files are byte-identical to the original snapshot. Only the merged
file changed:

```
c202b39cf3fe0ba77a7d6f138bb9e89dae007f0ac9541b491ae2d22ee0a5415c  src/orchestration/service.ts
08cf7886868de1551bae367f4c5e423a1b1e8631e8f37bdd01792a5e817bcf6f  (pre-merge snapshot)
```

`docs/parity-matrix.md` (`01fa4e6e...`) is already present with the snapshot's
exact content at `a95e4bb`, so it does not appear in the reconciled diff.

Reconciled patch `a95e4bb -> merged tree`, 59,183 bytes, 19 files:

```
98fd6f0f87a86d91cb772cb1acf946618ee31f1653776cd556481337f9afb17e  reconciled-on-a95e4bb.patch
```

It applies with `patch -p3` to a clean `a95e4bb` checkout and reproduces every
file byte-for-byte (verified with `cmp` on all 20 paths).

## 5. Why the implementation is not pushed yet

The available integration writes whole file contents inline. The change set is
242,341 bytes across 20 files (`openapi.json` alone is 83,014 bytes). Transferring
that as inline strings costs dozens of round trips and reintroduces exactly the
transcription risk this branch exists to work around. No Git transport with a
credential is available in this workspace: no `gh`, no token, no `~/.netrc`.

Minimum authorization to finish, if granted:

- A **fine-grained PAT**, resource owner `Auctivon-CoderaxAI`.
- Repository access: **only** `Coderax-WorkflowEngine`.
- Permissions: **Contents: Read and write**. Nothing else (no Actions, no
  Workflows, no Administration, no Secrets).
- Stored as a project secret so the sandbox can `git push`; never in chat, code,
  logs or committed files. Expire it in days, revoke when the PR is merged.

With that, the sequence is: clone, `git checkout -b feat/durable-events-impl` at
`a95e4bb`, apply `reconciled-on-a95e4bb.patch`, `npm ci && npm run verify`,
commit in staged batches, push, open a PR against
`feat/workflow-engine-foundation` with expected-HEAD protection.
