# Governance: what is enforceable at $0.00

Verified on 2026-11-26 against the live repository and the vendors' published
plans. Nothing here is inferred from a plan name.

## Branch protection is not available on this repository

```
$ gh api repos/Auctivon-CoderaxAI/Coderax-WorkflowEngine/branches/main/protection
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":403}

$ gh api repos/Auctivon-CoderaxAI/Coderax-WorkflowEngine/rulesets
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":403}
```

Branch protection and rulesets require GitHub Pro for a private repository.
Making the repository public would violate the owner's non-negotiable visibility
requirement, and upgrading would violate the $0.00 requirement. **The platform
gate cannot be enabled.** This is a documented limitation, not a waived rule.

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

| Reviewer | Free tier on a **private** repository | Verdict |
| --- | --- | --- |
| **Greptile** | Starter: 1 active developer, **50 credits/month, unlimited repositories, private repositories included**; a base review is 1 credit | **Usable.** The only zero-cost reviewer that actually reviews private pull requests. Requires the owner to install the GitHub App once. |
| CodeRabbit | Free plan covers unlimited repositories but on private code it produces **PR summaries only**; reviews are limited to 3 IDE and 3 CLI runs per hour. Full private reviews start at $24/developer/month | Not usable for a genuine private review without paying |
| Codex (ChatGPT code review) | Requires a paid ChatGPT plan | Not usable at $0 |
| GitHub Copilot review | Not available on Copilot Free for pull requests | Not usable at $0 |

Recommendation: install **Greptile Starter** on this repository (one click by the
owner; no card). It fits inside the free credit allowance for a repository of this
size, and its review would be a genuine independent signal.

Until a reviewer is installed, a pull request stays unapproved. Fabricating an
approval, self-approving, or merging without review is not an option.

## Continuous integration at $0.00

Hosted GitHub Actions cannot run: the account is billing-restricted, so the job
never starts.

```
The job was not started because recent account payments have failed or your
spending limit needs to be increased.
```

Options, cheapest first:

| Option | Cost | Requirement | Status |
| --- | --- | --- | --- |
| **Self-hosted GitHub Actions runner on the authorized Oracle Always Free instance** | $0 — self-hosted runners do not consume hosted minutes and are not affected by the hosted billing restriction | Access to the existing OCI host to register the runner | Recommended; blocked on host access |
| Cloudflare Workers Builds | $0 within the free build allowance | Connect the repository in the Cloudflare dashboard | Configurable build commands can run tests. Validate this repository’s verification command and free allowance remotely; engine deployment compatibility is a separate question. |
| Greptile | $0 Starter | App install | Reviews code, does not run tests |
| Purchasing hosted minutes | > $0 | — | Prohibited by the owner |

Until an authorized remote runner passes the required check, hosted verification
remains blocked. Prior workstation results are historical evidence; the charter
requires cloud compute for future verification.

### Configured gate (2026-11-26)

`.github/workflows/verify.yml` now defines the permanent quality gate using only
standard `ubuntu-latest` runners: one job for the build, every test suite and the
seven static gates; one for real MongoDB against a free `mongo:7` service
container; one for `npm audit` at high and critical. No larger runner, paid action
or purchased minute is used.

Hosted Actions are active and have completed runs at open PR heads; a branch push
alone does not trigger a run unless its branch is `main` or matches `ci/**`. A
missing run is therefore diagnosed as an absent trigger, not assumed to be a
billing restriction. See `docs/quality-gate.md`.

## Current state

| Item | State |
| --- | --- |
| `main` protection | Not enforceable (Pro-only); equivalent policy documented above |
| Reviewers installed | None |
| Approvals on PR #1 | 0 |
| Hosted CI | Active; 52 completed runs. Green at PR #2/#3/#4/#5/#7/#8/#9 heads, but those runs used `main`'s older workflow. The consolidated gate runs at `ci/**` pushes and PRs after merge |
| Local verification at this change | build 0, 182/182 tests, eleven static gates clean, real MongoDB 6/6 against mongod 7.0.14 |
| Dependency audit | Clean at the high/critical threshold after the zod 4.6.7 correction |
