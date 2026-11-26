import type { CapabilityEntry, CapabilityName, CapabilityReport, CapabilityState } from '@coderax/contracts';
import { summarizeCapabilities } from '@coderax/contracts';
import type { ArtifactService } from '../artifacts/service.js';
import type { ProviderPolicyRegistry, ProcessingOperation } from '../models/policy.js';
import type { ModelRouter } from '../models/router.js';

/**
 * The single capability registry.
 *
 * It does not implement anything and it does not call a provider. It reports what
 * the engine actually has: which module implements a capability, whether a
 * provider is configured, whether execution has been proven, whether policy
 * allows the processing operation, and whether the route is verified zero-cost.
 *
 * Rows are only `available` when the implementation exists, its storage or
 * provider is configured, and no policy gate refuses it. Everything else is
 * reported as `unavailable`, `unconfigured`, `blocked` or `unverified`; a
 * provider's documentation is never used as evidence of working execution.
 */

export type CapabilityRegistry = {
  report: () => CapabilityReport;
};

export function createCapabilityRegistry(input: {
  models: ModelRouter;
  policy: ProviderPolicyRegistry;
  artifacts: ArtifactService;
  now: () => Date;
}): CapabilityRegistry {
  function mediaEvidence(operation: ProcessingOperation): {
    privacyEligible: boolean;
    provider: string | null;
    providerConfigured: boolean;
    zeroCost: boolean;
  } {
    const providers = input.policy
      .list()
      .filter((policy) => policy.grants.some((grant) => grant.operation === operation));
    const freeRoute = input.models.hasVerifiedFreeRoute();
    const provider = providers[0]?.providerId ?? null;
    return {
      privacyEligible: providers.length > 0,
      provider,
      providerConfigured: provider !== null && freeRoute,
      zeroCost: provider !== null && freeRoute,
    };
  }

  function artifactRows(): CapabilityEntry[] {
    const durable = input.artifacts.durable;
    const storage = durable
      ? 'Durable artifact storage (MongoDB) is configured.'
      : 'Artifact storage is process-local; uploads are refused until persistence.driver=mongo.';
    const state: CapabilityState = durable ? 'available' : 'blocked';
    const detail = durable
      ? 'Deterministic writers verified by reading each artifact back.'
      : 'Generation runs, but a deliverable is refused because its bytes could not survive a restart.';
    const rows: Array<{ name: CapabilityName; implementation: string }> = [
      { name: 'document.intelligence', implementation: 'src/artifacts/document.ts' },
      { name: 'spreadsheet.intelligence', implementation: 'src/artifacts/workbook.ts' },
      { name: 'presentation.intelligence', implementation: 'src/artifacts/deck.ts' },
      { name: 'data.analysis', implementation: 'src/artifacts/data.ts' },
      { name: 'software.engineering', implementation: 'src/artifacts/software.ts' },
    ];
    return rows.map((row) => ({
      name: row.name,
      state,
      implementation: row.implementation,
      provider: null,
      providerConfigured: durable,
      operational: true,
      operationalDetail: 'Produced and read back in the artifact test suite.',
      privacyEligible: true,
      zeroCost: true,
      detail: `${storage} ${detail}`,
    }));
  }

  function report(): CapabilityReport {
    const freeRoute = input.models.hasVerifiedFreeRoute();
    const vision = mediaEvidence('multimodal');
    const capabilities: CapabilityEntry[] = [
      {
        name: 'text.intelligence',
        state: freeRoute ? 'available' : 'unconfigured',
        implementation: 'src/models/router.ts + src/agents/native/agent.ts',
        provider: vision.provider,
        providerConfigured: freeRoute,
        operational: freeRoute,
        operationalDetail: freeRoute
          ? 'Executed through the routed gateway in the router and native test suites.'
          : 'No verified zero-cost route is available, so no inference has been executed.',
        privacyEligible: freeRoute,
        zeroCost: freeRoute,
        detail: freeRoute
          ? 'At least one verified zero-cost model is routable for chat and work.'
          : 'No verified zero-cost model is routable; paid endpoints are never substituted.',
      },
      {
        name: 'image.understanding',
        state: 'unverified',
        implementation: 'src/agents/native/agent.ts (image content parts)',
        provider: vision.provider,
        providerConfigured: vision.providerConfigured,
        operational: false,
        operationalDetail:
          'Image content parts are constructed for a vision model, but no live provider image request has been executed here.',
        privacyEligible: vision.privacyEligible,
        zeroCost: vision.zeroCost,
        detail:
          'Implemented only for models that declare image input. Without a recorded live execution it stays unverified.',
      },
      ...mediaRows,
      ...artifactRows(),
      {
        name: 'browser.intelligence',
        state: 'unavailable',
        implementation: 'none',
        provider: null,
        providerConfigured: false,
        operational: false,
        operationalDetail: 'No browser session, fetch tool or DOM runtime is implemented in this engine.',
        privacyEligible: false,
        zeroCost: true,
        detail: 'Unavailable: no browser execution module exists.',
      },
      {
        name: 'game.studio',
        state: 'unavailable',
        implementation: 'none',
        provider: null,
        providerConfigured: false,
        operational: false,
        operationalDetail: 'No game project generator is implemented.',
        privacyEligible: false,
        zeroCost: true,
        detail: 'Unavailable: Native Game Studio is not part of this engine.',
      },
      {
        name: 'gaming.agent',
        state: 'unavailable',
        implementation: 'none',
        provider: null,
        providerConfigured: false,
        operational: false,
        operationalDetail: 'No gaming agent runtime is implemented.',
        privacyEligible: false,
        zeroCost: true,
        detail: 'Unavailable: Native Gaming Agent is not part of this engine.',
      },
    ];
    return summarizeCapabilities(capabilities, input.now().toISOString());
  }

  const noAdapter = (name: CapabilityName, detail: string): CapabilityEntry => ({
    name,
    state: 'unavailable',
    implementation: 'none',
    provider: mediaEvidence('multimodal').provider,
    providerConfigured: false,
    operational: false,
    operationalDetail: detail,
    privacyEligible: mediaEvidence('multimodal').privacyEligible,
    zeroCost: false,
    detail: `Unavailable: ${detail}`,
  });

  const mediaRows: CapabilityEntry[] = [
    noAdapter('image.generation', 'no provider adapter implements image generation'),
    noAdapter('image.editing', 'no provider adapter implements image editing'),
    noAdapter('audio.understanding', 'no provider adapter implements audio input'),
    noAdapter('audio.transcription', 'no provider adapter implements transcription'),
    noAdapter('speech.generation', 'no provider adapter implements speech synthesis'),
    noAdapter('video.understanding', 'no provider adapter implements video input'),
  ];

  return { report };
}
