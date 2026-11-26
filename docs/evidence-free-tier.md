# Zero-cost provider evidence (checked 2026-11-26)

The engine does not hardcode a "free" model. This page records the provider
facts that were checked while building the evidence gate. It is **not** a
configuration: an operator must record `models.evidence[].terms` and an
inference observation for the exact model and account they use. Prices, model
availability and terms change, and every provider page below says so in its own
words.

## What was verified

| Provider | Published fact | Source |
| --- | --- | --- |
| OpenRouter | Free model variants are capped at 20 requests/minute and 50 requests/day, rising to 1,000/day after a lifetime purchase of at least $10 of credits. Failed attempts count, and a negative balance can block free models. | <https://openrouter.ai/docs/faq>, <https://openrouter.ai/pricing>, <https://openrouter.ai/docs/api/reference/limits> |
| OpenRouter | Free and paid models may route to upstream providers with different logging/training terms. The account has a separate setting for providers that may train on free-model prompts. | <https://openrouter.ai/docs/guides/privacy/provider-logging> |
| Google Gemini | The free tier is per model: some models are "Free of charge", others are "Not available" on the free tier. Free-tier content is marked "Used to improve our products: Yes" on the pricing page; paid-tier content is marked "No". Quotas apply per project, not per API key. | <https://ai.google.dev/gemini-api/docs/pricing>, <https://ai.google.dev/gemini-api/docs/billing>, <https://ai.google.dev/gemini-api/docs/rate-limits> |
| Groq | A free plan exists with per-model RPM/RPD/TPM/TPD limits; the rate-limits page is a high-level summary and points to the console for the organization's exact limits. | <https://console.groq.com/docs/rate-limits> |

Three consequences are encoded in this branch:

1. **A model-list response is not price evidence.** OpenRouter publishes prices
   per model and may expose a `:free` catalog entry; Gemini and Groq do not
   publish a per-model zero price in their listing response. Authentication and
   listing therefore establish credential readiness only.
2. **A model identifier, a `:free` suffix, a plan name or an account tier is not
   evidence.** `src/models/eligibility.ts` refuses a model with no unexpired
   `terms` record, even if its identifier looks free.
3. **An observed inference is a separate record.** `inferenceObservedAt` and
   `inferenceSource` are not inferred from `terms` or from a configured key.

## What was not verified

- **Account eligibility**: no provider account or credential exists in this
  workspace. No live request was sent, so no account's free-tier eligibility,
  payment state or model access was confirmed.
- **Actual inference**: the test suite uses a scripted gateway. A successful
  inference can only be recorded by the owner after observing it in the
  provider's console.
- **Current model availability**: free model lists rotate. No model ID from this
  page is shipped as available or free.
- **Quota exhaustion at the provider**: the engine's local reservation,
  concurrency and release logic is tested, but no live 429/`RESOURCE_EXHAUSTED`
  response was produced.
- **Privacy enforcement**: `privacySource` and `promptTraining` record the
  published term and expose it in `GET /v1/models`. The engine cannot enforce a
  third party's data policy.

## Why the tests use `provider.example`

The test configuration records a synthetic `https://provider.example` observation
so the routing path can be exercised without claiming anything about a real
provider. It is deliberately not a real domain or model. A deployment that
copies that configuration would route nothing, because the test evidence is not a
licence to use any provider.
