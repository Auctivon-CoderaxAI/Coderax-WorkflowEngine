# Zero-cost model routing

`src/models` is the only component that decides which model runs. It is provider
independent: a provider is an adapter that reports facts and executes a request.
Cost verification, capability classification, ranking, budgets, rate limits,
circuits, fallback, streaming normalization and health all live above that
boundary.

There is no second selector. `src/models/catalog.ts` is a type alias for the
routing port in `src/models/router.ts`; `src/agents/native/gateway.ts` and the
old static catalogue were removed. An agent receives a resolved `ModelRef` and
calls the router through the gateway port; it never sees a provider URL or key.

## Invariants

1. **Zero cost is proven, never assumed.** An API key is authentication only. A
   `:free` suffix, an account tier, a model name or provider marketing is not
   evidence.
2. **Unknown cost is refused.** A model with no price list and no unexpired
   attestation is reported as `paid` and can never be routed. An explicitly
   requested paid or unknown model fails with `paid_model_refused`.
3. **Fail closed.** When no verified-free model is currently usable, routing
   returns `model_missing` and the request does not leave the process.
4. **Bounded fallback.** At most `maxCandidates` models are ranked and at most
   `1 + maxFallbacks` are attempted. Fallback never leaves the verified-free set.
5. **No silent explicit substitution.** A model named by the owner is pinned. An
   automatically chosen model may fall back within the free set.
6. **One router.** Nothing else selects a provider or model.

## Discovery and free-tier verification

`refresh()` calls every configured provider's discovery endpoint with a bounded
timeout. Startup always performs one refresh; a timer repeats it every
`models.routing.discoveryIntervalMs` (default 10 minutes, `unref`'d so it cannot
hold the process open).

| Provider kind | Discovery | Price evidence |
| --- | --- | --- |
| OpenAI-compatible (OpenRouter, Groq, Cerebras, custom, OpenCode server) | `GET {baseURL}/models` | The provider's `pricing` object when present |
| Gemini native | `GET {baseURL}/models` with `x-goog-api-key` | None; exact-model attestation is required |

OpenRouter publishes prices per token/request. A model is free only when **every
numeric price field is zero**, `prompt` and `completion` are present, and no
conditional `overrides` are published. Any positive field, a structured price or
a missing prompt/completion price makes it non-free. Groq and Cerebras do not
publish a price in their model lists, so they need attestations. Gemini publishes
none at all, so it always needs an attestation.

### Attestations

An attestation is a time-bounded operator statement about **one exact model**:

```json
{
  "providerId": "gemini",
  "modelId": "gemini-2.5-flash",
  "evidenceUrl": "https://ai.google.dev/gemini-api/docs/pricing",
  "verifiedAt": "2026-11-26T00:00:00.000Z",
  "expiresAt": "2026-12-26T00:00:00.000Z"
}
```

The URL must be `https`. Expired, future-dated or invalid attestations are not
evidence. Expiry is checked on every route, not only on refresh, so a stale claim
stops routing immediately. Config refuses an attestation whose `expiresAt` is not
after `verifiedAt`.

### No-longer-free endpoints

Every refresh rebuilds the free set from the provider's current response. A model
that was free and is now priced, removed, deprecated or missing a context window
is removed from the route immediately. A provider whose discovery fails has all
its models excluded until a refresh succeeds; the last-known rows remain visible
as unavailable for diagnosis.

## Capability classification

| Capability | Evidence |
| --- | --- |
| Text | The model is in the provider's chat/completions-capable list |
| Vision | Provider metadata (`architecture.input_modalities` includes `image`; Gemini's documented multimodal families) |
| Tool calling | Provider metadata (`supported_parameters` contains `tools`/`tool_choice`; Gemini `generateContent` function calling) |
| Streaming | Provider supports the normalized streaming surface |
| Reasoning | `verified` by a local benchmark, otherwise `declared` when provider metadata advertises a reasoning parameter, otherwise `unknown` |
| Coding | **Never inferred.** `verified` only by a local benchmark; otherwise `unknown` |

Groq and Cerebras model lists do not expose supported parameters. Their models are
therefore classified as not tool-capable until the provider metadata changes or a
future adapter can establish it. The router does not invent the capability.

## Routing modes

The service derives a mode from the task; callers of the router may name one
explicitly.

- **Fast** — short, simple Chat/Work objectives without tools or images. Weights
  quality 0.05, reliability 0.15, latency 0.80.
- **Complex** — code fences, implementation/debug/analysis language, objectives
  over 1,500 characters, tools or images. Weights quality 0.65, reliability 0.25,
  latency 0.10.
- **Auto** — everything else. Weights quality 0.45, reliability 0.35, latency 0.20.

Quality is the benchmark score when a current result exists, otherwise a
conservative baseline: 0.5 for a declared reasoning model, 0.35 otherwise.
Reliability is a Laplace-smoothed success ratio from observed calls. Latency is an
EWMA of successful call duration. A small preference bonus follows
`models.route` when scores tie; it cannot make a paid or unavailable model
eligible.

All candidates must also pass:

- verified free cost and current cost evidence;
- available provider, closed or half-open circuit, no quota cooldown;
- declared support for required vision/tools;
- `estimatedInputTokens + maxOutputTokens + contextMargin <= contextTokens`.

Token estimation is deliberately conservative: `ceil(characters / 3) + 4` per
message, plus 1,024 tokens per image, plus the system prompt. Unknown context
windows are excluded rather than guessed.

## Budgets and provider limits

The daily ledger reserves before the call:

- one request slot;
- estimated input tokens plus the output ceiling.

The reservation counts against the day until it is settled with actual usage or
released because no provider was called. Concurrent requests cannot each see the
same remaining allowance. Exhaustion raises `budget_exhausted`; the request is not
sent and there is no paid path to fall through to.

Per-provider local ceilings are configured as `requestsPerMinute`,
`tokensPerMinute` and `maxConcurrency`. They are local safety limits, not claims
about a provider's current published quota. Provider responses are still checked:
`retry-after`, `x-ratelimit-*`, `insufficient_quota`, `RESOURCE_EXHAUSTED` and
`PerDay` markers are recognized. A quota response cools the whole provider down
until its reset, and health exposes `quotaUntil`.

The limiter and metrics are process-local. A multi-replica deployment needs a
shared limiter before it can treat these ceilings as global; this is recorded as a
limitation rather than hidden.

## Circuits and fallback

Each model and each provider has a circuit with a configurable failure threshold
(default 3) and cooldown (default 30 seconds). Repeated server, network, timeout or
rate-limit failures open it. After the cooldown one half-open probe is admitted; a
success closes the circuit, a failure reopens it.

Fallback is attempted only for retryable provider failures and only before any
streamed output has reached the caller. Once a token is emitted, switching models
would duplicate or corrupt text, so the stream fails instead. Authentication
failures exclude the provider; quota failures cool it down; cancellation is never
retried.

## Streaming and tool normalization

Both adapters normalize to:

```text
text | reasoning | tool | usage | done
```

OpenAI-compatible SSE reassembles fragmented `tool_calls[].function.arguments` by
index and emits one complete tool call at the end. Gemini `functionCall` parts
become the same `ToolCall` shape. Invalid JSON arguments are preserved with
`rawArguments`; they are not silently replaced with `{}`.

The router adds a `model` event before an attempt so the caller can record which
model actually served the request. The native agent consumes the stream and
reports text deltas; it does not claim tool execution (`tools: false`).

## Health

`router.health()` reports verified-free count, current route, provider discovery
state, quota cooldown, circuit state, last error (sanitized), and per-model
attempts/successes/failures/consecutive failures/latency. The composition root
adds a non-required `models` health check; Native's own availability is required
and becomes unavailable when no verified-free route exists, so a deployment does
not silently start with only paid options.

## Configuration

Secrets never go in `engine.json`. Standard environment variable names are
detected automatically:

| Provider | Key variables | Default base URL |
| --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_KEY` | `https://openrouter.ai/api/v1` |
| Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Cerebras | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` |
| Custom OpenAI-compatible | `CODERAX_INFERENCE_KEY` plus `CODERAX_INFERENCE_BASE_URL` | operator supplied |

Explicit provider configuration can name a different URL and variable, including
an operator-run OpenCode server's OpenAI-compatible endpoint:

```json
{
  "models": {
    "route": [{ "providerId": "openrouter", "modelId": "inclusionai/ling-3.2-flash:free" }],
    "providers": [
      {
        "id": "openrouter",
        "kind": "openai",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "requestsPerMinute": 15,
        "tokensPerMinute": 100000,
        "maxConcurrency": 2
      }
    ],
    "attestations": [],
    "routing": {
      "maxCandidates": 4,
      "maxFallbacks": 2,
      "failureThreshold": 3,
      "cooldownMs": 30000,
      "discoveryIntervalMs": 600000,
      "defaultMaxOutputTokens": 1024,
      "contextMarginTokens": 64
    },
    "dailyRequestBudget": 1000,
    "dailyTokenBudget": 2000000
  }
}
```

OpenCode is an agent shell, not a free inference provider. Pointing `providers` at
an OpenCode server only works if that endpoint exposes models whose price is zero
or whose exact models have an attestation; the router does not treat a local
OpenCode server as free by assumption.

## Reproducible benchmarks

`benchmarks/suite.json` is a fixed, versioned suite graded deterministically at
temperature 0. `npm run benchmark` runs it against every currently routable
verified-free model and writes an artifact containing the suite digest, capture
time, per-model sample count, coding/reasoning/tool pass rates and latency.

See `benchmarks/README.md` for the methodology and limits. Benchmarks are optional
quality evidence: a model without one remains routable but is classified
conservatively, and no provider marketing number is imported.

## Evidence captured in this change

`docs/evidence-openrouter.json` records a public capture of
`https://openrouter.ai/api/v1/models` at 2026-11-26T17:55:01.380Z:

- 477 total models;
- 14 with zero prompt, completion and request prices;
- 9 of those accept image input;
- 12 declare tools and 12 declare reasoning;
- the response SHA-256 is recorded so the capture can be identified.

No credential was used or stored. This is discovery evidence, not a claim that any
particular model was benchmarked for quality. Live quality benchmarks were **not**
run in this change because no provider credential exists in the authoring
environment; the benchmark harness and its deterministic grader are covered by
tests, and the command is documented.

## Limitations

- Discovery schemas are provider-specific and can change. A changed schema fails
  that provider's discovery closed; it does not fall back to guessed capabilities.
- Gemini and Groq/Cerebras need exact-model attestations because they publish no
  machine-readable price.
- Rate limits, budgets and metrics are process-local.
- The benchmark suite is small and measures smoke-level coding/reasoning/tool
  behavior, not a full model evaluation. It is reproducible and local, not
  exhaustive.
- The router cannot prove a provider will not change its price mid-day; it
  re-verifies on the configured interval and on every free-tier credential check it
  can observe.
