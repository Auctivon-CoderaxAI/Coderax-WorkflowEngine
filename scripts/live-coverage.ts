import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Feature-to-live-evidence requirements.
 *
 * A feature can be fully unit-tested and still have no proof that its durable
 * behavior survives a real database. These requirements are deliberately
 * conditional: the current main branch has no artifact/event/schedule/browser
 * subsystem, so it does not pretend to test one. When the owning branch adds the
 * source, the live suite becomes mandatory and the architecture gate fails if it
 * is missing.
 */
export type LiveRequirement = {
  feature: string;
  source: string;
  test: string;
  database: boolean;
  detail: string;
};

export const LIVE_REQUIREMENTS: readonly LiveRequirement[] = Object.freeze([
  {
    feature: 'Durable Artifacts',
    source: 'src/artifacts',
    test: 'tests/live/artifacts.test.ts',
    database: true,
    detail: 'artifact persistence, quota admission and reference counting require a real database',
  },
  {
    feature: 'Durable Events',
    source: 'src/events/log.ts',
    test: 'tests/live/events.test.ts',
    database: true,
    detail: 'event replay and notification recovery require a real database',
  },
  {
    feature: 'Durable Scheduling',
    source: 'src/scheduling/engine.ts',
    test: 'tests/live/scheduling.test.ts',
    database: true,
    detail: 'schedule deduplication and recovery require a real database',
  },
  {
    feature: 'Browser orchestration',
    source: 'src/browser',
    test: 'tests/live/browser.test.ts',
    database: false,
    detail: 'browser control has an external provider boundary that must be exercised live',
  },
  {
    feature: 'Media processing',
    source: 'src/media',
    test: 'tests/live/media.test.ts',
    database: false,
    detail: 'media processing has external/provider behavior that must be exercised live',
  },
  {
    feature: 'Creative generation',
    source: 'src/creative',
    test: 'tests/live/creative.test.ts',
    database: false,
    detail: 'creative generation has external/provider behavior that must be exercised live',
  },
]);

export type LiveCoverageFinding = {
  rule: string;
  path: string;
  detail: string;
};

function exists(root: string, relative: string): boolean {
  return existsSync(path.join(root, relative));
}

export function checkLiveCoverage(root: string): LiveCoverageFinding[] {
  const findings: LiveCoverageFinding[] = [];
  for (const requirement of LIVE_REQUIREMENTS) {
    if (!exists(root, requirement.source)) continue;
    if (!exists(root, requirement.test)) {
      findings.push({
        rule: 'missing_live_coverage',
        path: requirement.source,
        detail: `${requirement.feature}: ${requirement.detail}; add ${requirement.test} to the mongo-live gate`,
      });
      continue;
    }
    if (!requirement.database) continue;
    const testText = readFileSync(path.join(root, requirement.test), 'utf8');
    if (!testText.includes('CODERAX_TEST_MONGO_URI')) {
      findings.push({
        rule: 'live_database_not_explicit',
        path: requirement.test,
        detail: `${requirement.feature}: live database tests must read CODERAX_TEST_MONGO_URI so a missing server fails instead of skipping`,
      });
    }
  }
  return findings;
}
