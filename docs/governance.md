# Governance: what is enforceable at $0.00

Verified on 2026-11-26 against the live repository and the vendors' published
plans. Nothing here is inferred from a plan name.

## Repository visibility and branch protection

The source repository is intentionally **public** so it can use the free
GitHub-hosted Actions allowance and public-repository rulesets. This is a
source-code visibility decision, not an application-access decision: the Coderax
application remains owner-only, has no public-facing endpoint, and never stores
credentials, conversations, memory, artifacts or personal data in the
repository. No one may change repository visibility without an explicit owner
decision.

Public source visibility does not authorize publishing runtime data or secrets.
The earlier text in this file treated private visibility as a requirement and
concluded that hosted CI could not run; that conclusion was based on a private
repository and is superseded.

Rulesets and branch protection are available to public repositories, but this
workspace has no repository-admin credential. Their enabled state must be
verified by an owner who holds that credential; this document does not claim a
gate is enabled when it could not be inspected.

### Equivalent policy that is followed instead

The rules are enforced by process, and every pull request records the evidence:

| Rule | How it is honoured without platform enforcement |
| --- | --- |
| No direct push to `main` | Every change lands through a pull request from a short-lived branch. `main` has one commit and no direct push since creation. |
| Independent approval | A pull request is not merged by its author without a recorded review. The current PR has **no** approval and is therefore not merged. |
| Required checks at the current head | `npm run verify` is run at the pushed head and its exact output pasted into the pull request. A pass at an earlier head is not accepted. |
| Code-owner review | `.github/CODEOWNERS` names the owner for every path. |
| No force-push, no branch deletion | Followed by policy; `main`'s history is linear and unchanged. |
| No bypass | No administrator override exists to use, and none is simulated. |

The gap this leaves is real: nothing prevents a direct push except discipline. It
is recorded here so it is never mistaken for enforcement.

## Reviewers available at $0.00

| Reviewer | Free tier with the **public source** repository | Verdict |
| --- | --- | --- |
| **Greptile** | Starter: 1 active developer, **50 credits/month, unlimited repositories**; a base review is 1 credit | **Usable.** A zero-cost reviewer that reviews pull requests. Requires the owner to install the GitHub App once. |
| CodeRabbit | Free plan covers unlimited repositories but on private code it produces **PR summaries only**; reviews are limited to 3 IDE and 3 CLI runs per hour. Full private reviews start at $24/developer/month | Not usable for a genuine private review without paying |
| Codex (ChatGPT code review) | Requires a paid ChatGPT plan | Not usable at $0 |
| GitHub Copilot review | Not available on Copilot Free for pull requests | Not usable at $0 |

Recommendation: install **Greptile Starter** on this repository (one click by the
owner; no card). It fits inside the free credit allowance for a repository of this
size, and its review would be a genuine independent signal.

Until a reviewer is installed, a pull request stays unapproved. Fabricating an
approval, self-approving, or merging without review is not an option.

## Continuous integration at $0.00

Public source repositories use the free GitHub-hosted Actions allowance. The
`verify` workflow is configured for pull requests targeting `main` and pushes to
`main`; a feature branch with no pull request therefore has no hosted run. The
exact-head run is produced when the PR is opened. Do not treat a local run as a
hosted run.

If the repository is ever made private, hosted Actions may become unavailable
under the account's billing state. That is a visibility/billing decision for the
owner, not a reason to weaken verification.

Fallbacks, cheapest first:

| Option | Cost | Requirement | Status |
| --- | --- | --- | --- |
| **GitHub-hosted Actions on public source** | $0 within the public-repository allowance | Open a PR targeting `main` | Primary path; no exact-head run exists until the PR is opened |
| Self-hosted runner on the authorized Oracle Always Free instance | $0 — self-hosted runners do not consume hosted minutes | Access to the OCI host to register the runner | Fallback; blocked on host access |
| Cloudflare Workers Builds | $0 within the free build allowance | Connect the repository in the Cloudflare dashboard | Fallback; separate compatibility question |
| Greptile | $0 Starter | App install | Reviews code, does not run tests |
| Purchasing hosted minutes | > $0 | — | Prohibited by the owner |

## Current state

| Item | State |
| --- | --- |
| `main` protection | Not verified; public repositories support rulesets, but this workspace has no admin credential. Equivalent policy documented above. |
| Reviewers installed | None |
| Approvals on PR #1 | 0 |
| Repository visibility | Public source; application access remains owner-only |
| PR for `feat/durable-artifacts` | None |
| Hosted CI at `bf2e9b2` | No run: no PR exists, and `verify` triggers on PR/main |
| Local verification at `bf2e9b2` | build 0, 157/157 tests, contract gate clean; real MongoDB |
| Local verification after the artifact integration | build 0, 166/166 tests, contract gate clean; real MongoDB |
| Dependency audit | `npm audit --omit=dev` reports one high finding, `GHSA-mrhx-c7xc-m3w5` / CVE-2023-54404 for `zod <4.6.6`; the CVE was rejected by its CNA, the owner-only API has a hard request-body limit, and the Zod 4 migration belongs to the quality-gate owner. Not suppressed. |
