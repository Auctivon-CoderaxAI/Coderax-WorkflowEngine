# Governance: public source, private application, free CI

Verified on 2026-11-26 against the public repository metadata. Nothing below is
inferred from a plan name, and no visibility, permission or protection setting
was changed by this branch.

```console
$ curl -s https://api.github.com/repos/Auctivon-CoderaxAI/Coderax-WorkflowEngine
{"private": false, "visibility": "public", "default_branch": "main", ...}
```

## What is public, and what is not

| Surface | Visibility | Notes |
| --- | --- | --- |
| Source repositories (WorkflowEngine and the other Coderax sources) | **Public** | Deliberate: standard GitHub-hosted Actions are free for public repositories. |
| Deployed owner application | **Private, owner-only** | Access is authenticated; public source never implies public application access. |
| Conversations, projects, memory, artifacts | **Private per owner** | Enforced by the engine's owner/mode/conversation isolation, not by repository visibility. |
| Credentials, provider keys, production infrastructure | **Restricted** | Supplied through environment and deployment secrets; never committed. |
| Data modes | **`private` and `cloud` are separate** | A private conversation, workspace or transcript is never reused for cloud work. |

A public repository is a source-code disclosure, nothing more. The deployment,
its data and its credentials remain private, and the security tests in
`tests/security/` are what enforce that separation.

## CI at $0.00

Standard GitHub-hosted runners are free for public repositories. The
`verify` workflow runs on `ubuntu-latest` with no paid runner, action, database
or model; the real-MongoDB job uses the pinned `mongo:7.0.14` service container.
The workflow triggers on every pull request targeting `main` and on pushes to
`main`, so a passing result is only meaningful at the exact pushed head.

`npm run verify` is the local equivalent. It requires a disposable
`CODERAX_TEST_MONGO_URI` and runs every gate exactly once.

## Protection and review status (read-only verification)

| Requirement | Verified state | How it was checked |
| --- | --- | --- |
| Repository visibility | Public (`private: false`) | Unauthenticated repository metadata |
| Default branch | `main` | Same metadata |
| Rulesets | None configured (`[]`) | `GET /repos/.../rulesets` |
| Classic branch protection | **Not verifiable unauthenticated** (`401 Requires authentication`) | `GET /repos/.../branches/main/protection` |
| CODEOWNERS | Present | `.github/CODEOWNERS` |
| Required CI workflow | Present | `.github/workflows/verify.yml` |
| Secret scanning / push protection | **Not verifiable unauthenticated** | Requires owner access to repository security settings |
| Independent approval | **Not yet obtained** | A PR must be opened and reviewed by someone other than the author |

No protection, permission or visibility setting was modified. The rules below
remain policy until an authorized owner confirms or enables platform
enforcement:

- No direct push to `main`; every change lands through a pull request.
- A pull request is not merged without a recorded independent approval.
- `npm run verify` must pass at the exact head being merged; an earlier pass is
  not accepted.
- No force-push, no branch deletion, no administrator bypass.

## Current state

| Item | State |
| --- | --- |
| Source visibility | Public (intentional) |
| Owner application / conversations / artifacts | Private and owner-scoped |
| Hosted Actions | Available at $0 for public repositories |
| Rulesets | None configured |
| Classic branch protection | Unverifiable without owner-authenticated read access |
| Independent review | Required, not yet recorded |
| Secret scanning / push protection | Owner must confirm in repository settings |

Until an owner-authorized read confirms branch protection and secret scanning,
those two rows stay "unverified" rather than being claimed as enabled.
