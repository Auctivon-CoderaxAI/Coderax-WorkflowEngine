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
    capabilities: [studioCapability, agentCapability, externalCapability],
  };
}
