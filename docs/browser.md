# Cloud browser and computer-use integration

## Status: contract complete, capability not operational

This repository implements Coderax Native's cloud browser integration surface: a
versioned contract, session lifecycle, navigation, inspection, screenshots,
accessible-element discovery, forms, keyboard and mouse input, tabs, file upload
and retrieval, pause/resume, cancellation, owner takeover, single-use approvals
and execution receipts.

There is **no verified cloud browser provider** in this repository or in its
deployment configuration. Therefore:

- `GET /v1/browser/capabilities` reports `operational: false` and
  `reason: disabled` or `not_configured` by default;
- every session creation and action is refused with a stable problem code;
- **no real browser session, page, screenshot, upload, download or takeover has
  been executed by this repository**;
- DeploymentPlatformAI **exists** as an owner-controlled engineering project:
  <https://github.com/DeploymentPlatformAI/DeploymentPlatform>. Its private
  repository was inspected through the authorized GitHub integration. It is a
  deployment control plane (Docker, self-hosted SSH, Runpod and ComputeFabric
  workload providers), not a browser runtime. It has no browser workload and no
  browser session API. Its Oracle Always Free host runbook explicitly provisions
  no host and requires OCI-console eligibility verification. No OCI tenancy,
  host, control-plane instance or browser workload is available in this
  workspace, so the capability remains fail-closed. See
  [browser-infrastructure.md](browser-infrastructure.md) for the evidence,
  resource sizing and required integration contract.
- Hosted browser SaaS providers are excluded by the `$0.00` charter. A
  self-hosted Chromium/Playwright workload on verified free compute remains the
  only evaluated path, and it is not operational.

The fake provider in `tests/fakes/browser.ts` and the protocol fixture in
`tests/integration/browser-remote.test.ts` are test doubles. They prove engine
policy, protocol parsing and fail-closed behavior. They are not evidence that
cloud browsing works.

The scope is **browser only**. Keyboard and mouse are page-level input. There is
no OS-level desktop control, no local Chrome, and no path that uses the owner's
computer as the execution environment.

## Surface

Every route is owner-authenticated and declared in
`packages/contracts/src/routes.ts`.

| Operation | Route | Purpose |
| --- | --- | --- |
| `browserCapabilities` | `GET /v1/browser/capabilities` | Truthful availability, per-feature support and limits |
| `listBrowserSessions` | `GET /v1/browser/sessions` | Owner-scoped sessions |
| `createBrowserSession` | `POST /v1/browser/sessions` | Create a cloud session with an exact origin allowlist |
| `getBrowserSession` | `GET /v1/browser/sessions/{sessionId}` | Current state, tabs, URL and expiry |
| `browserAction` | `POST /v1/browser/sessions/{sessionId}/actions` | One navigation, inspection, capture or input action |
| `pauseBrowserSession` | `POST .../pause` | Stop accepting actions, keep provider state |
| `resumeBrowserSession` | `POST .../resume` | Resume with tabs and page intact |
| `takeoverBrowserSession` | `POST .../takeover` | Hand control to the owner, or release it |
| `closeBrowserSession` | `POST .../close` | Cancel and release the cloud browser |
| `authorizeBrowserSession` | `POST .../authorize` | Request a single-use sensitive-action approval |
| `decideBrowserAuthorization` | `POST .../authorize/decision` | Approve or deny that request |
| `listBrowserReceipts` | `GET .../receipts` | Bounded action-evidence history |
| `getBrowserArtifact` | `GET /v1/browser/artifacts/{artifactId}` | Retrieve exact screenshot or file bytes |

The SDK exposes every operation on `CoderaxClient`.

## Session model

- `environment` is the literal `cloud`. A caller cannot request the owner's
  computer, and the engine has no local browser dependency.
- `origins` is required and describes exact origins. Paths, queries, fragments,
  credentials, wildcards and non-HTTP schemes are rejected. Navigating or
  opening a tab outside the list is refused before the provider is called. The
  provider must also enforce the allowlist; the engine additionally checks the
  URL returned by every action and fails the session if the provider reports a
  page outside it.
- A session expires on a bounded TTL (`sessionTtlMs`, requested TTL capped by it)
  and on shutdown. Expiry asks the provider to close the remote browser. A
  confirmed close marks the record `expired`; an unconfirmed close marks it
  `quarantined`, because reporting a clean expiry without terminating the
  remote workload would be false.
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:182443c2eed66a7db4cf704b45b75c1fd8e86770481e6e5b49f7ec7f9be709a5 -->

- At most `maxSessionsPerOwner` slots exist per owner. Pending creates and
  quarantined sessions occupy slots. A failed create releases its slot
  immediately only if the provider confirms it made no allocation. The HTTP
  adapter can confirm this for checks that stop the request before dispatch
  and for credential rejections (HTTP 401 or 403). All other failures without
  a confirmed outcome retain a slot for the full provider TTL after the
  failure is observed, because no session handle is available to close.
  Retry close to clean up a quarantined session. The engine retains the latest
  128 confirmed terminal sessions and their receipt histories across owners.

<!-- /coderabbit-ai-generated:v1 -->

- States are `ready`, `paused`, `owner_controlled`, `closed`, `expired`,
  `failed` and `quarantined`. An action on any state other than `ready` is
  refused with a receipt. `quarantined` means remote termination was **not**
  confirmed; it is terminal, is never reported as a clean close and is never
  reused.
- `sessionPersistence` means the provider keeps browser state (cookies, storage,
  current page and tabs) alive across actions and across pause/resume for the
  session TTL. It does not mean the engine control plane survives a restart: a
  restart loses the session records rather than inventing them, and the provider
  TTL releases the remote browser. This is reported rather than hidden; durable
  browser-session records would need a persistence decision.
- Shutdown asks the provider to release every live session. A confirmed release
  records `closed`; an unconfirmed release records `quarantined`. The provider's
  own TTL remains the final backstop, but it is not treated as termination
  evidence.

## Research and application-testing workflows

Both workflows use the same primitives; there is no separate mode that bypasses
policy.

- **Research**: create a `research` session with the sources' exact origins, then
  navigate, inspect, discover accessible elements, capture screenshots, download
  files and keep the receipt trail. Page text is untrusted data, never an
  instruction.
- **Application testing**: create a `testing` session, then fill and submit forms,
  press keys, use the mouse, switch tabs and upload or download fixtures. Every
  committing step still needs a declared intent and, when sensitive, an owner
  approval; screenshots and digests are the evidence a run produced.

## Sensitive actions and owner authorization

A sensitive category always needs a single-use, resource-scoped approval:

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:c5b66da38253f18773f8d23cb8cdf5635db2a3b0a551e6e657d99fb1dba6a94a -->

| Category | Permission scope | Example |
| --- | --- | --- |
| `purchase` | `browser.control` | Completing a checkout |
| `account_change` | `browser.control` | Changing account settings |
| `authentication` | `browser.control` | Declared sign-in intent or filling an observed password field |
| `irreversible` | `browser.control` | A committing click or key press |
| `file_transfer` | `browser.transfer` | Upload or download |

Callers must declare `authentication` for sign-in submissions. Protocol v1
reports element roles and input types but does not identify which actions
submit a sign-in form. An undeclared sign-in submission made with a committing
click or key press still needs approval under the fail-closed defaults below.

<!-- /coderabbit-ai-generated:v1 -->

Approvals are created through `.../authorize`, decided by the owner through
`.../authorize/decision`, and bound to
`browser:<sessionId>:<category>`. A grant is consumed **before** dispatch, so a
provider failure cannot replay it; a retry needs a new approval.

Fail-closed defaults:

- A `click` requires an approval unless it targets an observed `link` and the
  caller declares `navigate`. `form_input` is **not** a safe intent for a click:
  a button click can submit a form, delete data or perform another committing
  action.
- A `press` requires an approval unless the key only moves focus or scrolls
  (`Tab`, `Escape`, arrow keys, `PageUp`, `PageDown`, `Home`, `End`). `Enter`,
  `Space` and every other key can commit a form and need approval.
- Mouse `move` and `wheel` are non-committing. Mouse `down` and `up` need an
  approval. `tab.close` needs an approval. `upload` and `download` need a
  `file_transfer` approval regardless of the declared intent.
- Filling a non-password field with `form_input` is non-committing. Filling an
  element the provider identified as a password field is upgraded to
  `authentication`, even if the caller declared `form_input`.
- CAPTCHAs, access controls and provider restrictions are never bypassed. A
  caller that observes one must stop issuing actions, request a session pause,
  and notify the owner. Provider protocol v1 does not report challenge events;
  the engine does not automatically detect challenges, pause, or notify the owner.
- The owner sees the declared category and description on the receipt; an agent
  cannot use page text to relabel an action.

## Website content cannot change policy

Page text, titles, element labels and values are **untrusted data**:

- Every observation carries `trust: "untrusted"` as a literal.
- Control, zero-width and bidirectional characters are stripped; text is
  bounded to 20,000 characters and elements to 200.
- The engine never parses page content for instructions and never consults it to
  decide whether an action is authorized. Only the owner token, the permission
  store and the declared action determine authorization.
- Elements are addressed by provider-issued ids from a prior `inspect` or `find`,
  not by page-supplied scripts. An action naming an element the engine has not
  observed is refused.
- The injection test feeds a page that says the owner approved a purchase; the
  purchase still requires an owner approval, and the text is returned only as
  data.

## Screenshots, files and evidence

- A success receipt exists only after the provider returned the evidence the
  action required.
- A screenshot must be exactly one PNG or JPEG whose magic bytes match the
  declared type and whose size is within `maxScreenshotBytes`. The engine
  computes the SHA-256 of the exact bytes it received and stores that digest on
  the artifact. A text payload labelled `image/png`, a missing image or an
  unexpected artifact is a `protocol_error`; no screenshot is fabricated or
  implied.
- Downloads and uploads are bounded by `maxUploadBytes`, use canonical base64 and
  are stored with their digest. Active content types (`text/html`, SVG,
  JavaScript, XML) are refused as downloads.
- Artifacts are kept in bounded process memory. An evicted artifact is reported
  as `not_found`; its receipt remains, but no bytes are invented.
- Live-view URLs from takeover are returned once and never written to a session
  record, audit entry or receipt.

## Provider protocol v1

An authorized zero-cost provider implements this protocol over HTTPS (HTTP only
for loopback development):

| Method | Path | Body / response |
| --- | --- | --- |
| `GET` | `/v1/capabilities` | Protocol version, provider name, `costClass`, every feature flag, max TTL |
| `POST` | `/v1/sessions` | TTL, allowlist, label, purpose, viewport; returns provider session id, URL, title, tabs |
| `POST` | `/v1/sessions/{id}/actions` | `{ action, allowedOrigins }`; returns URL, title, tabs, optional observation and artifacts |
| `POST` | `/v1/sessions/{id}/pause` | `{ ok: true }` |
| `POST` | `/v1/sessions/{id}/resume` | `{ ok: true }` |
| `POST` | `/v1/sessions/{id}/takeover` | `{ interactiveUrl }` |
| `POST` | `/v1/sessions/{id}/release` | `{ ok: true }` |
| `POST` | `/v1/sessions/{id}/close` | `{ ok: true }` |

Requirements enforced by the adapter:

- Bearer token from the variable named by `browsers.remote.tokenEnv`; the token
  is never placed in a URL, a receipt, an audit entry or an error message.
- Redirects are refused, so the authorization header cannot move to another
  origin.
- Responses are bounded and strictly parsed against the v1 schemas. A malformed
  or partial response is a `protocol_error`, never a best-effort interpretation.
- The handshake must advertise **every** required feature and `costClass: "free"`.
  A paid, partial, unreachable or malformed provider is not operational.
- Action payloads omit `intent` and `approvalId`: the provider performs actions
  and never evaluates consent.

## Enabling a provider

```json
{
  "browsers": {
    "enabled": true,
    "provider": "http",
    "sessionTtlMs": 900000,
    "maxSessionsPerOwner": 3,
    "remote": {
      "baseURL": "https://browser.internal.example",
      "tokenEnv": "CODERAX_BROWSER_TOKEN",
      "timeoutMs": 30000,
      "zeroCostAttested": true
    }
  }
}
```

`browsers.allowPaid` is a literal `false` and cannot be enabled. The token is
read from the environment by name. Startup refuses an enabled HTTP provider that
has no base URL, is not owner-attested as authorized and zero-cost, or uses
plain HTTP for a non-loopback host.

## Evidence required before claiming the capability works

Do not mark cloud browsing operational from a fixture, a configuration change or
a green unit test. A real provider needs, at minimum:

1. A recorded capabilities handshake showing all features and `free`.
2. Session creation, navigation to an allowed origin and refusal of a different
   origin.
3. An inspection whose page text is returned with `trust: "untrusted"`.
4. A screenshot whose receipt digest matches the retrieved bytes.
5. Form input, keyboard and mouse actions and a tab operation.
6. An upload and a download whose digests match the retrieved bytes.
7. Pause/resume, owner takeover and release, then close.
8. Receipts for successes, refusals and failures.
9. A restart proving a lost control plane does not leave a usable session.
10. A second-owner request returning `not_found`.

Record receipt ids, artifact digests and the provider's protocol version in the
pull request. Never include the provider token, a live-view URL or private page
content.

## Limits

| Setting | Default | Bound |
| --- | --- | --- |
| `sessionTtlMs` | 15 minutes | 1 minute – 1 hour |
| `maxSessionsPerOwner` | 3 | 1 – 16 |
| `maxScreenshotBytes` | 2 MiB | 1 KiB – 4 MiB |
| `maxUploadBytes` | 512 KiB | 1 KiB – 512 KiB |
| Remote timeout | 30 s | 1 s – 120 s |

## Known gaps

- No verified provider exists; the default is fail-closed.
- Coderax Native still reports `tools: false`. This integration is the engine
  surface an owner client drives today; an autonomous Native browser-tool loop is
  a separate capability and is not claimed.
- Browser control-plane records are process-local; only provider-side sessions
  survive long enough to be resumed, and a restart deliberately loses control.
- Provider-side redirect enforcement is required by the protocol but cannot be
  proven until a real provider is verified; the engine detects the final URL and
  fails the session.
- DNS-rebinding and private-network blocking, egress restriction, browser-origin
  credential isolation and download isolation are provider obligations. No real
  provider exists, so those protections are not verified here. The engine does
  refuse active download types and verifies every returned main-frame and tab
  URL against the exact-origin allowlist.
- Durable browser sessions are **not implemented**. Control-plane records,
  approvals and artifact bytes are process-local. A restart cannot recover a
  session, and the provider TTL is the only remote backstop. The required
  persistence/lease/artifact integration is specified in
  [browser-infrastructure.md](browser-infrastructure.md); it must not be
  replaced with a second storage authority.
- There is no integrated Native browser planner step yet. The authoritative
  planner and router are in open PRs #2 and #3, not on `main`; this branch does
  not duplicate them. The exact integration contract is in
  [browser-infrastructure.md](browser-infrastructure.md).
- There is no Coderax Web or CLI browser screen/command in this repository. The
  SDK exposes the operations; the client owners must consume them.
- There is no OS-level desktop control and no plan to add one here.
