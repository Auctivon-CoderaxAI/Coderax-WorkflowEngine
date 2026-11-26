import type {
  CreateGameRequest,
  GameBuild,
  GameDesignPlan,
  GameExport,
  GameIteration,
  GameProject,
  GameProjectList,
  GameSpec,
} from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { GameStore, StoredFile } from './store.js';
import { generateGame, type Generation } from './generate.js';
import {
  applyInstruction,
  interpretPrompt,
  SUPPORTED_EDITS,
  validateBuildableSpec,
} from './spec.js';
import { verifyGeneration } from './verify.js';
import { createZip } from './zip.js';
import { digest } from './random.js';

/**
 * Native Game Studio.
 *
 * A project is persistent; a build is generated, verified and stored as real
 * files; an iteration edits the spec and rebuilds. Nothing here is a mock: the
 * source a client previews, exports or hands to the gaming agent is the source
 * the verifier measured.
 */

export type DesignAssistant = {
  available: boolean;
  narrate: (input: {
    ownerId: string;
    spec: GameSpec;
  }) => Promise<{ logline?: string; pillars?: string[] } | null>;
};

export type BuildAttempt = {
  attempt: number;
  passed: boolean;
  failedChecks: string[];
};

export type GameStudio = {
  create: (ownerId: string, request: CreateGameRequest) => Promise<ServiceResult<GameProject>>;
  list: (ownerId: string, input: { cursor?: string; limit: number }) => Promise<GameProjectList>;
  get: (ownerId: string, gameId: string) => Promise<ServiceResult<GameProject>>;
  saveSpec: (input: {
    ownerId: string;
    gameId: string;
    spec: GameSpec;
    expectedRevision: number;
  }) => Promise<ServiceResult<GameProject>>;
  build: (input: {
    ownerId: string;
    gameId: string;
    expectedSpecRevision?: number;
  }) => Promise<ServiceResult<GameBuild>>;
  iterate: (input: {
    ownerId: string;
    gameId: string;
    instruction: string;
    expectedRevision: number;
  }) => Promise<ServiceResult<GameIteration>>;
  preview: (ownerId: string, gameId: string) => Promise<ServiceResult<string>>;
  export: (ownerId: string, gameId: string) => Promise<ServiceResult<GameExport>>;
  readVerifiedBuild: (input: {
    ownerId: string;
    gameId: string;
    buildId: string;
  }) => Promise<ServiceResult<{ build: GameBuild; files: StoredFile[] }>>;
  lastAttempts: (gameId: string) => BuildAttempt[];
  readonly maxProjects: number;
};

function blueprintFor(spec: GameSpec, gameId: string): Generation {
  return generateGame({
    spec,
    gameId,
    buildId: `${gameId}-draft`,
    modelAssisted: false,
  });
}

function additiveSeed(seed: number, attempt: number): number {
  return (Math.imul(seed + attempt * 7919, 2654435761) >>> 0) % 2_147_483_647;
}

export function createGameStudio(input: {
  store: GameStore;
  artifacts: ArtifactStore;
  clock: Clock;
  ids: IdGenerator;
  assistant: DesignAssistant;
  maxProjects: number;
}): GameStudio {
  const attempts = new Map<string, BuildAttempt[]>();

  async function planFor(spec: GameSpec, gameId: string): Promise<GameDesignPlan> {
    const base = blueprintFor(spec, gameId);
    return base.plan;
  }

  async function getProject(ownerId: string, gameId: string): Promise<ServiceResult<GameProject>> {
    const project = await input.store.readProject(ownerId, gameId);
    if (!project) return fail('not_found', 'That game project does not exist for this owner.');
    return ok(project);
  }

  async function runBuild(inputBuild: {
    ownerId: string;
    project: GameProject;
    spec: GameSpec;
    narrative: { logline?: string; pillars?: string[] } | null;
    modelAssisted: boolean;
  }): Promise<{ build: GameBuild; generation: Generation }> {
    const { ownerId, spec } = inputBuild;
    const gameId = inputBuild.project.gameId;
    let lastGeneration: Generation | null = null;
    let lastVerification: ReturnType<typeof verifyGeneration> | null = null;
    let lastAttempt = 0;
    const history: BuildAttempt[] = [];

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptSpec: GameSpec =
        attempt === 1 ? spec : { ...spec, seed: additiveSeed(spec.seed, attempt) };
      const buildId = `${gameId}-r${inputBuild.project.specRevision}-a${attempt}`;
      const generation = generateGame({
        spec: attemptSpec,
        gameId,
        buildId,
        modelAssisted: inputBuild.modelAssisted,
        ...(inputBuild.narrative ? { narrative: inputBuild.narrative } : {}),
      });
      const verification = verifyGeneration({
        spec: attemptSpec,
        blueprint: generation.blueprint,
        files: generation.files.map((file) => ({
          path: file.path,
          kind: file.kind,
          content: file.content,
          digest: file.digest,
        })),
        now: input.clock.iso(),
      });
      const failedChecks = verification.verification.checks
        .filter((check) => !check.passed)
        .map((check) => check.id);
      history.push({ attempt, passed: verification.verification.passed, failedChecks });
      lastGeneration = generation;
      lastVerification = verification;
      lastAttempt = attempt;

      // A failed traversal is a geometry problem, which a new seed can repair.
      // Any other failure is reported, not hidden by another attempt.
      if (verification.verification.passed || !failedChecks.includes('levels.completable')) {
        break;
      }
    }

    const generation = lastGeneration as Generation;
    const verification = lastVerification;
    if (!verification) throw new Error('the build produced no verification result');
    const buildId = `${gameId}-r${inputBuild.project.specRevision}-a${lastAttempt}`;

    const artifactPaths: string[] = [];
    for (const frame of verification.frames) {
      const written = await input.artifacts.write({
        ownerId,
        mode: 'cloud',
        path: `games/${gameId}/builds/${buildId}/evidence/${frame.path}`,
        bytes: frame.png,
      });
      if (written.ok) artifactPaths.push(written.value.path);
    }
    const report = Buffer.from(`${JSON.stringify(verification.verification, null, 2)}\n`, 'utf8');
    const reportWritten = await input.artifacts.write({
      ownerId,
      mode: 'cloud',
      path: `games/${gameId}/builds/${buildId}/evidence/verification.json`,
      bytes: report,
    });
    if (reportWritten.ok) artifactPaths.push(reportWritten.value.path);

    const finalVerification = { ...verification.verification, artifactPaths };
    const build: GameBuild = {
      buildId,
      gameId,
      specRevision: inputBuild.project.specRevision,
      attempt: lastAttempt,
      status: finalVerification.passed ? 'verified' : 'failed',
      digest: generation.digest,
      entry: generation.entry,
      previewPath: `/v1/games/${gameId}/preview`,
      files: generation.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        bytes: file.bytes,
        digest: file.digest,
      })),
      verification: finalVerification,
      createdAt: input.clock.iso(),
    };

    await input.store.writeBuild({
      ownerId,
      gameId,
      build,
      files: generation.files.map((file) => ({
        path: file.path,
        kind: file.kind,
        content: file.content,
        digest: file.digest,
        bytes: file.bytes,
      })),
    });
    attempts.set(gameId, history);
    return { build, generation };
  }

  const studio: GameStudio = {
    maxProjects: input.maxProjects,
    lastAttempts: (gameId) => attempts.get(gameId) ?? [],

    create: async (ownerId, request) => {
      const count = await input.store.countProjects(ownerId);
      if (count >= input.maxProjects) {
        return fail(
          'conflict',
          `The owner already has the maximum of ${input.maxProjects} game projects.`,
        );
      }
      const gameId = input.ids.gameId();
      const interpreted = interpretPrompt(request.prompt);
      const narrative = input.assistant.available
        ? await input.assistant.narrate({ ownerId, spec: interpreted })
        : null;
      const spec: GameSpec = { ...interpreted };
      const plan = await planFor(spec, gameId);
      const now = input.clock.iso();
      const project: GameProject = {
        gameId,
        name: request.name,
        summary: request.summary ?? interpreted.prompt.slice(0, 600),
        spec,
        specRevision: 1,
        revision: 1,
        status: 'spec_ready',
        design: narrative
          ? { ...plan, ...(narrative.logline ? { logline: narrative.logline } : {}), ...(narrative.pillars ? { pillars: narrative.pillars } : {}), modelAssisted: true }
          : plan,
        build: null,
        createdAt: now,
        updatedAt: now,
      };
      const written = await input.store.writeProject({ ownerId, project, expectedRevision: null });
      return written;
    },

    list: async (ownerId, listInput) =>
      input.store.listProjects({
        ownerId,
        limit: listInput.limit,
        ...(listInput.cursor ? { cursor: listInput.cursor } : {}),
      }),

    get: getProject,

    saveSpec: async ({ ownerId, gameId, spec, expectedRevision }) => {
      const current = await getProject(ownerId, gameId);
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return fail('conflict', 'The project changed since the revision this request was based on.');
      }
      const plan = await planFor(spec, gameId);
      const next: GameProject = {
        ...current.value,
        spec,
        specRevision: current.value.specRevision + 1,
        revision: current.value.revision + 1,
        status: 'spec_ready',
        design: plan,
        updatedAt: input.clock.iso(),
      };
      return input.store.writeProject({ ownerId, project: next, expectedRevision });
    },

    build: async ({ ownerId, gameId, expectedSpecRevision }) => {
      const current = await getProject(ownerId, gameId);
      if (!current.ok) return current;
      const project = current.value;
      if (!project.spec) return fail('conflict', 'This project has no design spec to build.');
      if (expectedSpecRevision !== undefined && expectedSpecRevision !== project.specRevision) {
        return fail('conflict', 'The spec changed since the revision this build was based on.');
      }
      const buildable = validateBuildableSpec(project.spec);
      if (!buildable.ok) {
        return fail(
          'validation_failed',
          `${buildable.detail} Save a supported camera or single-player spec before building.`,
        );
      }
      const narrative = project.design?.modelAssisted
        ? {
            ...(project.design.logline ? { logline: project.design.logline } : {}),
            ...(project.design.pillars ? { pillars: project.design.pillars } : {}),
          }
        : null;
      const { build } = await runBuild({
        ownerId,
        project,
        spec: project.spec,
        narrative,
        modelAssisted: project.design?.modelAssisted ?? false,
      });
      const next: GameProject = {
        ...project,
        status: build.status === 'verified' ? 'verified' : 'failed',
        revision: project.revision + 1,
        build,
        updatedAt: input.clock.iso(),
      };
      const written = await input.store.writeProject({
        ownerId,
        project: next,
        expectedRevision: project.revision,
      });
      if (!written.ok) return written;
      return ok(build);
    },

    iterate: async ({ ownerId, gameId, instruction, expectedRevision }) => {
      const current = await getProject(ownerId, gameId);
      if (!current.ok) return current;
      if (current.value.revision !== expectedRevision) {
        return fail('conflict', 'The project changed since the revision this edit was based on.');
      }
      if (!current.value.spec) return fail('conflict', 'This project has no design spec to edit.');
      const edited = applyInstruction(current.value.spec, instruction);
      if (!edited) {
        return fail(
          'validation_failed',
          `That instruction did not match a supported edit. Supported edits: ${SUPPORTED_EDITS.join(', ')}.`,
        );
      }
      const plan = await planFor(edited.spec, gameId);
      const now = input.clock.iso();
      const editedProject: GameProject = {
        ...current.value,
        spec: edited.spec,
        specRevision: current.value.specRevision + 1,
        revision: current.value.revision + 1,
        status: 'spec_ready',
        design: plan,
        updatedAt: now,
      };
      const saved = await input.store.writeProject({
        ownerId,
        project: editedProject,
        expectedRevision,
      });
      if (!saved.ok) return saved;

      const buildable = validateBuildableSpec(edited.spec);
      if (!buildable.ok) {
        return fail('validation_failed', buildable.detail);
      }
      const { build } = await runBuild({
        ownerId,
        project: saved.value,
        spec: edited.spec,
        narrative: null,
        modelAssisted: false,
      });
      const next: GameProject = {
        ...saved.value,
        status: build.status === 'verified' ? 'verified' : 'failed',
        revision: saved.value.revision + 1,
        build,
        design: { ...plan, modelAssisted: false },
        updatedAt: input.clock.iso(),
      };
      const written = await input.store.writeProject({
        ownerId,
        project: next,
        expectedRevision: saved.value.revision,
      });
      if (!written.ok) return written;
      return ok({
        project: written.value,
        changes: edited.changes,
        debugAttempts: attempts.get(gameId)?.length ?? 1,
        modelAssisted: false,
      });
    },

    preview: async (ownerId, gameId) => {
      const current = await getProject(ownerId, gameId);
      if (!current.ok) return current;
      const build = current.value.build;
      if (!build || build.status !== 'verified') {
        return fail(
          'not_ready',
          'This project has no verified build yet; build it before opening a preview.',
        );
      }
      const stored = await input.store.readBuild(ownerId, gameId, build.buildId);
      if (!stored) return fail('not_found', 'The verified build is missing from storage.');
      const entry = stored.files.find((file) => file.path === build.entry);
      if (!entry) return fail('not_found', 'The build has no entry document.');
      if (digest(entry.content) !== entry.digest) {
        return fail('conflict', 'The stored preview does not match the verified build digest.');
      }
      return ok(entry.content);
    },

    export: async (ownerId, gameId) => {
      const current = await getProject(ownerId, gameId);
      if (!current.ok) return current;
      const build = current.value.build;
      if (!build || build.status !== 'verified') {
        return fail('not_ready', 'Only a verified build can be exported.');
      }
      const stored = await input.store.readBuild(ownerId, gameId, build.buildId);
      if (!stored) return fail('not_found', 'The verified build is missing from storage.');
      for (const file of stored.files) {
        if (digest(file.content) !== file.digest) {
          return fail('conflict', 'A stored file no longer matches the verified build digest.');
        }
      }
      const archive = createZip(
        stored.files
          .slice()
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((file) => ({ path: file.path, data: Buffer.from(file.content, 'utf8') })),
      );
      await input.artifacts.write({
        ownerId,
        mode: 'cloud',
        path: `games/${gameId}/exports/${build.buildId}.zip`,
        bytes: archive,
      });
      return ok({
        filename: `${current.value.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'game'}.zip`,
        mediaType: 'application/zip' as const,
        bytes: archive.length,
        digest: digest(archive),
        base64: archive.toString('base64'),
      });
    },

    readVerifiedBuild: async ({ ownerId, gameId, buildId }) => {
      const stored = await input.store.readBuild(ownerId, gameId, buildId);
      if (!stored) return fail('not_found', 'That build does not exist for this owner.');
      if (stored.build.status !== 'verified') {
        return fail(
          'conflict',
          'That build did not pass verification, so no agent may play it.',
        );
      }
      for (const file of stored.files) {
        if (digest(file.content) !== file.digest) {
          return fail('conflict', 'A stored file no longer matches the verified build digest.');
        }
      }
      return ok(stored);
    },
  };

  return studio;
}

