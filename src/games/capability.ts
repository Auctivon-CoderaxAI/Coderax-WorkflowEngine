import type { GameCapability, GameCapabilityReport } from '@coderax/contracts';

/**
 * The machine-readable capability registry rows for both game capabilities.
 *
 * This replaces doc-only claims with a status a client can render and a reviewer
 * can check. `operational` is reserved for code that this deployment actually
 * executes and verifies; anything that depends on an unverified external service
 * is `blocked`, with the exact prerequisite named.
 */

export type GameCapabilityInput = {
  now: string;
  studioEnabled: boolean;
  agentEnabled: boolean;
  sandboxReady: boolean;
  modelAssisted: boolean;
  studioMessage: string;
  agentMessage: string;
};

export function createGameCapabilityReport(input: GameCapabilityInput): GameCapabilityReport {
  const studioStatus =
    !input.studioEnabled ? 'unsupported' : input.sandboxReady ? 'operational' : 'blocked';
  const agentStatus =
    !input.agentEnabled ? 'unsupported' : input.sandboxReady ? 'operational' : 'blocked';

  const studioCapability: GameCapability = {
    id: 'native.game-studio',
    title: 'Native Game Studio',
    status: studioStatus,
    summary:
      'Natural-language game specs, design planning, original source generation, generated assets and procedural audio, levels, mechanics, self-contained browser previews, browser-boot and playability verification, persistent projects, build history/restore and exportable source.',
    available: studioStatus === 'operational',
    detail: input.studioMessage,
    evidence: [
      'tests/unit/games.test.ts — generation, composition, browser boot, procedural audio, isolation and measured playability',
      'tests/integration/games.test.ts — create, build, preview, export, build history/restore and verified play over HTTP',
      'tests/security/games.test.ts — owner scoping, traversal refusal and disabled-capability reporting',
      'docs/game-studio.md — generated artifact and verification model',
    ],
    environments: ['coderax-cloud-engine', 'browser-preview'],
    isolation: null,
    modelAssisted: input.modelAssisted,
    blockedBy: studioStatus === 'blocked' ? 'The isolated game runtime did not initialise.' : null,
  };

  const agentCapability: GameCapability = {
    id: 'native.gaming-agent',
    title: 'Native Gaming Agent',
    status: agentStatus,
    summary:
      'Creates durable game sessions against verified, version-pinned studio builds, observes frames and state, plans objectives, plays with bounded controls, supports pause/resume, owner takeover and cancellation, keeps session memory and logs, and verifies completion from measured state.',
    available: agentStatus === 'operational',
    detail: input.agentMessage,
    evidence: [
      'tests/integration/games.test.ts — session creation through verified completion, pause, takeover and cancel',
      'tests/security/games.test.ts — owner scoping and disabled-capability reporting',
      'docs/game-studio.md — session lifecycle and isolation boundary',
    ],
    environments: ['coderax-native-sandbox'],
    isolation: 'in-process-v8-context',
    modelAssisted: false,
    blockedBy: agentStatus === 'blocked' ? 'The isolated game runtime did not initialise.' : null,
  };

  const browserStudioCapability: GameCapability = {
    id: 'native.game-studio.browser',
    title: 'Native Game Studio — real-browser acceptance',
    status: 'degraded',
    summary:
      'Reference platformer and puzzle builds were rendered, controlled and completed in an actual Chromium browser, with screenshots and measured state.',
    available: false,
    detail:
      'Two reference builds passed desktop and 390px mobile Chromium acceptance: rendering, keyboard, mouse, touch, jump, collision, scoring, switch/goal completion, level advancement, restart, timer failure, audio synthesis and owner-only access. Other genres and Safari/Firefox are covered by the DOM boot and deterministic verifier, not by a real browser.',
    evidence: [
      'docs/evidence/browser/report.json — measured browser state and performance',
      'docs/evidence/browser/platformer-desktop.png, platformer-mobile.png, platformer-level2.png, puzzle-desktop.png, puzzle-mobile.png',
      'docs/evidence/browser/README.md — method, anonymous 403 / authenticated 200, limitations',
    ],
    environments: ['cloud-browser-chromium'],
    isolation: 'owner-only-preview-origin',
    modelAssisted: false,
    blockedBy:
      'There is no zero-cost browser CI or Safari/Firefox device matrix, so real-browser coverage is evidence for the reference builds rather than a per-build guarantee.',
  };

  const aiAssistedCapability: GameCapability = {
    id: 'native.game-studio.ai-assisted',
    title: 'Native Game Studio — AI-assisted generation',
    status: input.modelAssisted ? 'degraded' : 'blocked',
    available: false,
    summary:
      'A verified zero-cost model may add design narrative through the model catalogue and daily budget; code, levels and rules remain deterministic and measured.',
    detail: input.modelAssisted
      ? 'A zero-cost model route is configured, but this deployment has no executed model-assisted build to point at, so AI-assisted generation is not claimed as verified.'
      : 'No authorized zero-cost model credential is configured in this deployment. Natural-language interpretation, source generation and verification are deterministic and operational; no model output is being claimed.',
    evidence: [
      'src/games/assistant.ts — optional narrative-only model call through the verified zero-cost catalogue',
      'src/models/catalog.ts — paid models refused, budget enforced',
      'tests/unit/games.test.ts — deterministic generation and verification',
    ],
    environments: ['coderax-cloud-engine'],
    isolation: null,
    modelAssisted: input.modelAssisted,
    blockedBy: input.modelAssisted
      ? 'No executed model-assisted build exists to verify; a configured route is not evidence of participation.'
      : 'An owner-provided zero-cost model credential is required before AI-assisted generation can be claimed.',
  };

  const browserAgentCapability: GameCapability = {
    id: 'native.gaming-agent.browser',
    title: 'Native Gaming Agent — cloud-browser gameplay',
    status: 'blocked',
    available: false,
    summary:
      'Autonomous observation and control of an authorized game inside a cloud browser.',
    detail:
      'Blocked: the agent runtime is the engine V8 context over verified studio builds. The real-browser acceptance run used a test controller and browser screenshots; it is not an integrated cloud-browser observation/control adapter, and no zero-cost browser session service is verified.',
    evidence: [
      'docs/evidence/browser/report.json — browser acceptance, not agent runtime evidence',
      'src/games/session.ts — V8 session loop over verified builds',
    ],
    environments: [],
    isolation: null,
    modelAssisted: false,
    blockedBy:
      'A verified zero-cost cloud browser with owner-scoped sessions and an observation/control interface is required.',
  };

  const externalCapability: GameCapability = {
    id: 'native.gaming-agent.external',
    title: 'Gaming Agent — external game environments',
    status: 'blocked',
    summary:
      'Playing an authorized third-party or browser-hosted game requires a verified cloud browser and a game-provider interface.',
    available: false,
    detail:
      'Blocked: this deployment has no verified zero-cost cloud browser and no independently verified DeploymentPlatformAI workload or browser interface. The engine will not stream an owner device, bypass anti-cheat, or claim an external session it cannot isolate.',
    evidence: [
      'Cross-repository audit (2026-11-26): DeploymentPlatformAI appears only as a deployment executor reference in Coderax docs.',
      'Coderax packages/api/src/cyvox/addon.ts proxies read-only status, not a workload or browser interface.',
      'Coderax docs/product/CAPABILITY_REGISTRY.md CX-33 records the Gaming Agent as blocked for external environments.',
    ],
    environments: [],
    isolation: null,
    modelAssisted: false,
    blockedBy:
      'A verified zero-cost cloud browser plus an authorized game-provider interface must exist before this capability can be claimed.',
  };

  return {
    checkedAt: input.now,
    capabilities: [
      studioCapability,
      browserStudioCapability,
      aiAssistedCapability,
      agentCapability,
      browserAgentCapability,
      externalCapability,
    ],
  };
}
