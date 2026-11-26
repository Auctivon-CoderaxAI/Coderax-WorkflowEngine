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
| Website content overriding agent permissions | Page observations are marked `trust: "untrusted"`, sanitized and bounded; the engine never parses them for instructions and authorizes only from the owner token and permission store |
| A sensitive browser action without owner consent | Purchases, account changes, authentication, irreversible actions and file transfers need a single-use, resource-scoped approval that is consumed before dispatch; committing actions without a declared intent fail closed |
| Fabricated or altered browser evidence | A success receipt requires provider bytes; screenshots must match PNG/JPEG magic and size limits, and every artifact carries a locally computed SHA-256 digest |
| Browser provider token disclosure | Token is read by variable name, sent only as a bearer header, redirects are refused, and the token is never placed in a URL, record, receipt or error |
| A browser session reaching the owner's computer | Sessions are `environment: "cloud"`; the engine has no local browser dependency and refuses every operation without a verified remote provider |
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
- The browser provider token is read from the variable named by
  `browsers.remote.tokenEnv` (default `CODERAX_BROWSER_TOKEN`) and is only ever
  sent as a bearer header to the attested endpoint. It is never stored in
  configuration, a receipt, an audit entry, a live-view URL or an error.
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
