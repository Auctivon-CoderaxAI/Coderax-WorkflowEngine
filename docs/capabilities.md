# Capability registry

`src/capabilities/registry.ts` is the only report of what this engine can do. It
is exposed at `GET /v1/capabilities` and shared by the HTTP API and the SDK.

Every row states:

- `implementation` — the module that implements the capability, or `none`;
- `provider` / `providerConfigured` — the configured provider and whether a
  verified zero-cost route exists;
- `operational` — whether a real execution path has been exercised;
- `privacyEligible` — whether an owner-approved policy grants the processing
  operation in cloud mode;
- `zeroCost` — verified zero-cost routing with no paid fallback;
- `state` — `available`, `unavailable`, `unconfigured`, `blocked` or `unverified`.

A capability is `available` only when its implementation exists, its storage or
provider is configured, and policy does not refuse it. Provider documentation is
never evidence: image understanding stays `unverified` until a live provider
image request is recorded, and image generation, editing, audio, speech and video
are `unavailable` because no adapter implements them.

Document, spreadsheet, presentation, data-analysis and software deliverables are
deterministic, so they are `available` when durable artifact storage is
configured and `blocked` when it is not. The registry does not advertise a
capability whose bytes would disappear with the process.
