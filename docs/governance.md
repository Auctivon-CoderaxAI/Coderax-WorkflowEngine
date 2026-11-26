# Governance: what is enforceable at $0.00

Updated 2026-11-26 against the live repository. Nothing here is inferred from a
plan name.

## Source visibility does not make the application public

The owner intentionally made the Coderax source repositories public so standard
GitHub-hosted Actions run at no cost. That decision applies to **source code
visibility only**. The deployed application, owner data, credentials,
conversations, memory and artifacts remain private, and this repository still
publishes no public-facing endpoint.

Do not describe the deployed system as public, and do not weaken owner-only
authentication because the source can be read.

## Branch protection is available, but is not verified enabled

Public repositories support branch protection and rulesets on the free plan. The
earlier claim that protection required GitHub Pro applied to a private
repository and is obsolete. This branch did not change repository settings;
whether protection is currently enabled must be checked in Settings rather than
assumed.

### Equivalent policy that is followed regardless

Every pull request records the evidence:

| Rule | How it is honoured |
| --- | --- |
| No direct push to `main` | Every change lands through a pull request from a short-lived branch. |
| Independent approval | A pull request is not merged by its author without a recorded review. |
| Required checks at the current head | `npm run verify` and hosted CI are run at the pushed head; a pass at an earlier head is not accepted. |
| Code-owner review | `.github/CODEOWNERS` names the owner for every path. |
| No force-push | Changes are additive; no history is rewritten. |
| No bypass | No administrator override is used or simulated. |

The gap is real: until platform protection is verified enabled, nothing prevents
a direct push except discipline. It is recorded here so it is never mistaken for
enforcement.

## Reviewers available at $0.00

| Reviewer | Free tier on a **public source repository** | Verdict |
| --- | --- | --- |
| **Greptile** | Starter: 1 active developer, 50 credits/month; a base review is 1 credit. Requires the owner to install the GitHub App once. | Usable as an independent signal; not installed. |
| CodeRabbit | Free plan covers unlimited repositories; review depth varies by plan. | Not relied on here. |
| Codex (ChatGPT code review) | Requires a paid ChatGPT plan. | Not usable at $0. |
| GitHub Copilot review | Plan-dependent. | Not relied on here. |

No reviewer is installed on this repository. A pull request stays unapproved
until a genuine review is recorded. Fabricating an approval, self-approving, or
merging without review is not an option.

## Continuous integration at $0.00

Hosted GitHub Actions now run on this public repository. Exact-head evidence:

| Run | Head | Result |
| --- | --- | --- |
| `45885151358` | `77cc40b49e8f` | `verify` success |
| `45877952215` | `c0cfa993ef2d` | `verify` success |
| `45877479332` | `a22c496daa52` | `verify` success |

The workflow installs from the lockfile, builds, runs the full test suite and
checks OpenAPI drift. Hosted runs are free standard runners; no paid minutes are
purchased. Local `npm run verify` remains the fast feedback loop, not a substitute
for the exact-head hosted run.

## Current state

| Item | State |
| --- | --- |
| Source visibility | Public, by owner decision, for free standard Actions |
| `main` protection | Available on the free plan; enabled state not verified by this branch |
| Reviewers installed | None |
| Pull request for this branch | Not opened (no write credential in the agent environment) |
| Hosted CI at `77cc40b` | Success |
| Local verification at `77cc40b` | 209/209 tests, OpenAPI drift clean |
