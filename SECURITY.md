# Security policy

## Scope

This repository is a private, owner-only execution engine. It has exactly one
principal and no public-facing endpoint. It is not a multi-tenant product, and it
must never grow signups, memberships, billing or B2B surfaces.

## Threat model

| Risk | Control |
| --- | --- |
| Unauthenticated API use | Owner bearer token, constant-time comparison, 401 on every owner route |
| Token guessing | Minimum length enforced at startup; a short token blocks startup |
| Token disclosure | Token is read from the environment by variable name, never stored in config, never logged, never placed in a URL or an error body |
| Cross-owner data access | Every read is scoped by `ownerId`; a foreign id is reported as `not_found`, not `forbidden`, so existence is not leaked |
| Private data reaching a cloud run | Workspaces and memory are partitioned by data mode; real paths are resolved and overlapping roots are refused at startup |
| Agent escapes its workspace | Workspace root is resolved through symlinks and must sit inside its mode root; a link into the other mode is rejected |
| Silent agent substitution | Selection is fail-closed: a disabled or unconfigured agent is refused with a typed error and no task is created |
| Unapproved tool or resource use | Permission requests name one scope and one exact resource; a grant approves only that resource |
| Paid model use | `allowPaid` is a literal `false`; a paid model is refused with `paid_model_refused`; a daily request/token budget fails closed |
| Stale run overwriting newer state | Every terminal write is fenced by a unique `runToken`; a mismatch writes nothing |
| Duplicate or replayed events | Events are sequenced by the bus; a duplicate id or stale sequence is reported, not applied |
| Secret in logs or errors | Client-facing detail is user-safe; upstream payloads, stacks and absolute paths are never forwarded |
| Denial of service by body size | Request bodies are bounded at 1 MiB and rejected with a typed problem |
| Public exposure | The engine binds loopback by default; `0.0.0.0` is a deliberate operator change, not a default |

## Secret handling

- `CODERAX_OWNER_TOKEN` (or the variable named by `auth.tokenEnv`) is the only
  credential this service accepts. Generate it with `openssl rand -hex 32`.
- Inference keys are read from `CODERAX_INFERENCE_KEY` and are only sent to the
  configured endpoint. They are never returned in a response.
- No secret belongs in `engine.json`, a test fixture, a log line, an error message,
  an issue or a pull request. `.env` is ignored; `.env.example` documents names
  only.
- If a secret is exposed, rotate it and record the rotation; do not rewrite
  history and assume the exposure is gone.

## Reporting

Report a vulnerability privately to the repository owner (`@nnabdelshahid`).
Do not open a public issue and do not include a working exploit, a live token or
private data in the report.

## Out of scope

- The web client's rendering, browser storage and UI authorization presentation
  are owned by the `Coderax` repository.
- Infrastructure hardening of the host (firewall, SSH, TLS termination) is owned by
  the deployment environment and recorded in `deploy/`.
