import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GameBuild, GameFile, GameProject, GameProjectList } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Persistent game projects.
 *
 * A project lives under the cloud workspace root as real files: `project.json`
 * plus one directory per build containing the generated source it exported. That
 * is what makes a project survive an engine restart without a database, and it
 * keeps the verified bytes and the downloadable bytes identical. Every read
 * checks the recorded owner id, and every write is atomic (temp file + rename).
 */

export type StoredFile = {
  path: string;
  kind: GameFile['kind'];
  content: string;
  digest: string;
  bytes: number;
};

export type StoredBuild = {
  build: GameBuild;
  files: StoredFile[];
};

export type ProjectRecord = {
  ownerId: string;
  project: GameProject;
};

export type GameStore = {
  readProject: (ownerId: string, gameId: string) => Promise<GameProject | null>;
  writeProject: (input: {
    ownerId: string;
    project: GameProject;
    expectedRevision: number | null;
  }) => Promise<ServiceResult<GameProject>>;
  listProjects: (input: {
    ownerId: string;
    cursor?: string;
    limit: number;
  }) => Promise<GameProjectList>;
  writeBuild: (input: {
    ownerId: string;
    gameId: string;
    build: GameBuild;
    files: StoredFile[];
  }) => Promise<void>;
  readBuild: (ownerId: string, gameId: string, buildId: string) => Promise<StoredBuild | null>;
  countProjects: (ownerId: string) => Promise<number>;
  root: string;
};

function gameIdIsSafe(gameId: string): boolean {
  return /^[A-Za-z0-9_-]{8,120}$/.test(gameId);
}

function buildIdIsSafe(buildId: string): boolean {
  return /^[A-Za-z0-9_.-]{1,160}$/.test(buildId) && !buildId.includes('..');
}

async function writeAtomic(target: string, data: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, 'utf8');
  await rename(temporary, target);
}

export function createGameStore(input: { root: string }): GameStore {
  async function readRecord(ownerId: string, gameId: string): Promise<ProjectRecord | null> {
    if (!gameIdIsSafe(gameId)) return null;
    try {
      const text = await readFile(path.join(input.root, gameId, 'project.json'), 'utf8');
      const record = JSON.parse(text) as ProjectRecord;
      if (!record || record.ownerId !== ownerId || !record.project) return null;
      return record;
    } catch {
      return null;
    }
  }

  async function countProjects(ownerId: string): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(input.root);
    } catch {
      return 0;
    }
    let count = 0;
    for (const entry of entries) {
      const record = await readRecord(ownerId, entry);
      if (record) count += 1;
    }
    return count;
  }

  return {
    root: input.root,
    readProject: async (ownerId, gameId) => (await readRecord(ownerId, gameId))?.project ?? null,
    writeProject: async ({ ownerId, project, expectedRevision }) => {
      if (!gameIdIsSafe(project.gameId)) {
        return fail('validation_failed', 'That project identity is invalid.');
      }
      const existing = await readRecord(ownerId, project.gameId);
      if (existing && existing.ownerId !== ownerId) {
        return fail('not_found', 'That game project does not exist for this owner.');
      }
      if (expectedRevision !== null) {
        if (!existing) return fail('not_found', 'That game project does not exist for this owner.');
        if (existing.project.revision !== expectedRevision) {
          return fail('conflict', 'The project changed since the revision this request was based on.');
        }
      } else if (existing) {
        return fail('conflict', 'That project identity is already in use.');
      }
      const directory = path.join(input.root, project.gameId);
      await mkdir(directory, { recursive: true });
      await writeAtomic(
        path.join(directory, 'project.json'),
        `${JSON.stringify({ ownerId, project } satisfies ProjectRecord, null, 2)}\n`,
      );
      return ok(project);
    },
    listProjects: async ({ ownerId, cursor, limit }) => {
      let entries: string[];
      try {
        entries = await readdir(input.root);
      } catch {
        return { projects: [], nextCursor: null };
      }
      const records: GameProject[] = [];
      for (const entry of entries) {
        const record = await readRecord(ownerId, entry);
        if (record) records.push(record.project);
      }
      records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
      const page = records.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        projects: page,
        nextCursor: next < records.length ? String(next) : null,
      };
    },
    writeBuild: async ({ ownerId, gameId, build, files }) => {
      if (!gameIdIsSafe(gameId) || !buildIdIsSafe(build.buildId)) {
        throw new Error('invalid game or build identity');
      }
      const directory = path.join(input.root, gameId, 'builds', build.buildId);
      await mkdir(directory, { recursive: true });
      for (const file of files) {
        const target = path.resolve(directory, file.path);
        const prefix = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
        if (!target.startsWith(prefix)) throw new Error('build file path escapes the build directory');
        await mkdir(path.dirname(target), { recursive: true });
        await writeAtomic(target, file.content);
      }
      await writeAtomic(
        path.join(directory, 'build.json'),
        `${JSON.stringify({ ownerId, build, files }, null, 2)}\n`,
      );
    },
    readBuild: async (ownerId, gameId, buildId) => {
      if (!gameIdIsSafe(gameId) || !buildIdIsSafe(buildId)) return null;
      try {
        const text = await readFile(
          path.join(input.root, gameId, 'builds', buildId, 'build.json'),
          'utf8',
        );
        const stored = JSON.parse(text) as { ownerId: string; build: GameBuild; files: StoredFile[] };
        if (stored.ownerId !== ownerId || !stored.build || !Array.isArray(stored.files)) return null;
        return { build: stored.build, files: stored.files };
      } catch {
        return null;
      }
    },
    countProjects,
  };
}
