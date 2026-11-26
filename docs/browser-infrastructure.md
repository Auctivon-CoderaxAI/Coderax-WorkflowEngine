# Cloud browser infrastructure and integration record

This document records what was actually inspected for the cloud browser
capability. It is deliberately separate from the implemented engine contract in
[browser.md](browser.md): the contract is testable without a provider, while
operational claims require the evidence below.

**Status: no zero-cost browser environment is verified. No provider workload was
provisioned and no real browser action was executed. Spend remains $0.00.**

## 1. DeploymentPlatformAI is an existing owner-controlled project

The canonical repository is
<https://github.com/DeploymentPlatformAI/DeploymentPlatform> (private). The
organization is <https://github.com/DeploymentPlatformAI>. It was inspected
through the authorized GitHub integration with repository admin permission.

What it is, from its own `PROJECT_CONTEXT.md` and
`DEPLOYMENT_PLATFORM_ENGINEERING_REPORT.md`:

- An independent, owner-operated **deployment control plane**, not a commercial
  browser SaaS and not a browser runtime.
- Python/FastAPI with persisted projects, deployments, releases, logs, usage,
  encrypted secrets, provider adapters and a deterministic lifecycle.
- Workload providers include local Docker, self-hosted SSH/Docker, Runpod and
  ComputeFabric. A provider owns `estimate`, `provision`, `health`, `stop`,
  `restart`, `delete`, logs and usage.
- Cost is gated: zero-cost mode refuses a billable estimate even when a caller
  asks for approval.
- The only checked-in workload is `workloads/ollama-gateway`. There is no
  browser, Chromium, Playwright or computer-use workload.
- Public application routing is optional and Caddy-based. The control API is
  loopback-only behind an owner SSH tunnel in the standalone profile.

The earlier conclusion that DeploymentPlatformAI could not be found was wrong.
Public web search did not identify a private project; the authorized repository
inspection does. The engine still does not claim an operational browser because
the project does not expose a browser workload contract.

## 2. Oracle Always Free evaluation

`DeploymentPlatformAI/DeploymentPlatform/ops/standalone/README.md` documents the
intended zero-cost host:

| Item | Documented value | Consequence for a browser |
| --- | --- | --- |
| Shape | `VM.Standard.A1.Flex`, ARM64 | Works for Chromium/Playwright if an A1 instance is actually available |
| Free allowance | 1,500 OCPU-hours + 9,000 GB-hours per month (2 OCPU + 12 GB continuously) | One browser worker is feasible; a browser fleet is not |
| Alternative AMD | `VM.Standard.E2.1.Micro`, 1 GB RAM | **Insufficient** for a modern Chromium build and Node/Playwright |
| Block storage | 200 GB Always Free; 47 GB minimum boot | Browser image, OS and temporary profile must be bounded |
| Region | Tenancy home region | Capacity is not guaranteed; "out of host capacity" is documented |
| Idle policy | Oracle may reclaim an A1 instance idle for 7 days | A low-traffic browser host is reclaimable; off-host state is mandatory |
| Ingress | SSH 22 from the owner's current address; optional 80/443 for Caddy | No public browser control endpoint is acceptable |

The runbook explicitly says this repository **does not provision a host**. It
requires the owner to verify in the OCI console that the account and selected
resources are Always Free with a `$0.00` estimate, that home-region A1 capacity
exists, that existing usage fits the allowance, and that no paid shape, load
balancer, NAT gateway or backup policy is selected. It also warns that a checked
box is not proof.

### What cannot be verified from this workspace

The authorized GitHub integration exposes repository content. It does not expose:

- an OCI tenancy, console session, billing export or cost report;
- an existing DeploymentPlatform control-plane instance;
- a registered self-hosted machine, SSH key, host inventory or Docker access;
- a deployed browser workload or its health endpoint;
- an independent zero-cost attestation.

A manual `zeroCostAttested: true` flag is a configuration gate, **not** evidence
of zero-cost operation. The same is true of a provider's self-reported
`costClass: "free"`. Neither substitutes for an OCI cost/billing record tied to
the actual tenancy and resource.

### Resource estimate, to be measured rather than assumed

A single headless Chromium process plus a Playwright driver, one browser context
and a small Node service is the only sensible first workload on 2 OCPU / 12 GB:

- OS + container image: ~2–4 GB disk, idle memory a few hundred MB.
- Chromium + renderer + Playwright driver: commonly ~1–3 GB RSS for one context;
  pages with large DOMs, video or many tabs can exceed that.
- Temporary profile, downloads and screenshots: bound to a small volume and a
  short TTL; never let them fill the 47 GB boot volume.
- CPU: two vCPUs are enough for one active page, not for parallel video or
  several contexts. Concurrency must start at 1 and be raised only from measured
  RSS/CPU evidence.
- Egress: must be measured against the tenancy's free outbound allowance; a
  research crawl can consume it quickly.

These are planning bounds, not measured facts. No host was available to measure
them.

## 3. Required DeploymentPlatform browser workload contract

No operational endpoint is invented here. If DeploymentPlatform owners add a
browser workload, the smallest compatible contract is:

1. **Workload type / image**: an owner-built container from a pinned Chromium and
   Playwright base, non-root, read-only root filesystem where practical, a
   writable bounded `/tmp` and profile volume, no Docker socket, no host network,
   no privileged mode.
2. **Private listener**: the browser service listens on a container-private port.
   Only the DeploymentPlatform control plane or an owner SSH tunnel can reach it;
   it is never published on 80/443. A bearer token is supplied by secret
   injection and never baked into an image.
3. **Protocol**: implement provider protocol v1 from
   [browser.md](browser.md) exactly: capabilities, create, act, pause, resume,
   takeover, release, close, strict JSON, bounded artifacts, no redirects, and a
   truthful `costClass`.
4. **Session registry**: provider-side lookup by session id after an engine
   restart, plus an idempotent terminate operation. Without this, Coderax can
   only quarantine a lost session and wait for the provider TTL.
5. **Health and limits**: `/health` reports browser readiness, active session
   count, memory/CPU headroom and the configured concurrency. The engine must
   refuse to create a session when the host is over its cap.
6. **Network policy**: exact-origin allowlist enforced in the browser context,
   no private-network, link-local, metadata, loopback or file access, no
   unrestricted downloads, and DNS resolution pinned away from private ranges
   (including rebinding checks). Egress is deny-by-default except the approved
   origins and package/image sources.
7. **Evidence**: OCI billing/usage export showing the resource as Always Free and
   `$0.00`, the actual shape/region, image digest, provider handshake and a
   termination test. The control plane records the deployment ID, revision and
   provider instance ID.
8. **Ownership**: one owner principal; no tenant or public signup. Owner
   approvals remain in Coderax. DeploymentPlatform must not become the permission
   authority for browser actions.

The existing Coderax HTTP adapter can speak this contract once such a workload
exists. The engine still owns approvals, origin policy, sensitive-action
classification and receipts; the workload owns only the browser process.

## 4. Zero-cost acceptance path

Do this only after the owner has an OCI tenancy with a verified Always Free
allowance and has explicitly approved provisioning:

1. Record the OCI estimate and billing state; confirm no paid shape, load
   balancer, NAT gateway or backup policy.
2. Provision one A1 host through the existing DeploymentPlatform self-hosted or
   Docker provider; do not create a second deployment system.
3. Build and deploy the browser workload; record image digest and revision.
4. Run the provider handshake and record every feature and the free cost claim.
5. Run the synthetic acceptance suite in [browser.md](browser.md): create,
   navigate, inspect, screenshot, element action, tabs, upload/download,
   pause/resume, takeover/release, close, owner-only access, refusal of a foreign
   origin and a second owner.
6. Measure RSS, CPU, disk and egress at idle and under one active session.
7. Kill the engine process, restart it, and prove the remote session is either
   recovered through the registry or terminated/quarantined. A TTL alone is not
   restart recovery.
8. Record the receipt ids, artifact digests and termination evidence. If any
   step is missing, the capability remains non-operational.

## 5. Native planner, Web, CLI and gaming coordination

The engine currently has no authoritative model router or Native planner on
`main`. Two open pull requests hold that work:

- #2 `feat/intelligence-core` (tool loop, router, MCP, retrieval, approvals),
- #3 `feat/native-reasoning-planner` (dependency-aware planner and verifier).

They are active, unmerged and target `main`. This browser branch does not merge
or duplicate them. The browser surface is therefore driven by an owner client
through the API/SDK, and Native still reports `tools: false`.

The required Native integration, once the authoritative planner lands, is:

- a `browser` plan-step kind and an action port that can only call
  `BrowserService`, never a provider directly;
- the existing permission gate maps sensitive categories to single-use approvals
  before the step executes;
- observations enter model context only as `trust: "untrusted"` data with bounded
  text/elements;
- verification cites browser receipts and artifact digests, not model prose;
- self-correction is bounded by the planner's existing attempt/replan limits;
- cancellation closes the session and a failed close quarantines it.

Coderax Web (`Auctivon-CoderaxAI/Coderax`) and CoderaxCLI
(`Auctivon-CoderaxAI/CoderaxCLI`) are separate owner repositories. They contain
no browser-session UI or command today. The Engine SDK is the shared contract;
clients must consume the same owner-authenticated operations and must not create
their own session store or permission model.

Native Game Studio / Gaming Agent repositories were not discoverable through the
current integration. Browser gameplay must use the same browser session contract
with an isolated game origin, bounded human-like controls, owner takeover,
pause/cancel and objective verification from receipts. No anti-cheat bypass,
credentialed-game automation or second browser runtime is permitted.

## 6. Explicit blockers

| Blocker | Evidence | Effect |
| --- | --- | --- |
| No verified OCI host | DeploymentPlatform runbook; no OCI console/tenancy access here | Cannot verify Always Free capacity, egress or `$0.00` |
| No browser workload | DeploymentPlatform `workloads/` contains only `ollama-gateway` | No endpoint to call |
| No provider registry/recovery API | Only a TTL close is documented | Restart can only quarantine, not recover |
| No durable browser store | Engine browser store is process-local | Receipts/approvals are lost on restart |
| No authoritative artifact service in this repo | Persistence owns tasks, messages, memory, leases only | Screenshot/download bytes are bounded process memory |
| Native planner/router unmerged | PRs #2 and #3 are open | Cannot wire an autonomous browser step without duplicating active work |
| No Web/CLI browser surface | Inspected public repositories at `main` | SDK exists; clients not integrated |
| No game studio repository access | Organization search did not identify one | Gaming integration cannot be reviewed |

Each blocker is a real dependency, not a reason to fabricate an endpoint. The
safe default remains `operational: false`.
