import type { GameDesignPlan, GameSpec, GameMechanic } from '@coderax/contracts';
import type { GameBlueprint, LevelData } from './types.js';

/**
 * The design plan is a real artifact the owner can read before spending a build.
 * It is derived from the spec and the generated levels, so it cannot describe a
 * mechanic the build does not contain.
 */

const MECHANIC_PURPOSE: Record<GameMechanic, { purpose: string; systems: string[] }> = {
  gravity: { purpose: 'Grounds the player so height and falls matter.', systems: ['physics', 'respawn'] },
  jump: { purpose: 'Lets the player cross gaps and reach ledges.', systems: ['input', 'physics'] },
  double_jump: { purpose: 'Adds a second mid-air impulse for recovery routes.', systems: ['input', 'physics'] },
  dash: { purpose: 'A short burst that fits through hazards quickly.', systems: ['input', 'physics'] },
  shoot: { purpose: 'Lets the player defeat patrols at range.', systems: ['projectiles', 'combat'] },
  enemies: { purpose: 'Patrolling opponents create timing pressure.', systems: ['ai', 'combat'] },
  hazards: { purpose: 'Static danger punishes careless movement.', systems: ['collision', 'health'] },
  collectibles: { purpose: 'Optional pickups reward exploration with score.', systems: ['collision', 'scoring'] },
  moving_platforms: { purpose: 'Moving geometry changes the route over time.', systems: ['physics', 'timing'] },
  push_blocks: { purpose: 'Blocks let the player reshape a corridor.', systems: ['collision', 'physics'] },
  switches: { purpose: 'A switch gates the exit until it is reached.', systems: ['collision', 'objective'] },
  timer: { purpose: 'A countdown bounds each attempt.', systems: ['objective', 'hud'] },
};

const KEYS: Record<string, string> = {
  left: 'ArrowLeft / A',
  right: 'ArrowRight / D',
  up: 'ArrowUp / W',
  down: 'ArrowDown / S',
  jump: 'Space',
  fire: 'F',
  dash: 'Shift',
};

export function controlsFor(spec: GameSpec): Array<{ action: string; keys: string; description: string }> {
  const actions = ['left', 'right'];
  if (spec.camera === 'side_view') actions.push('jump');
  else actions.push('up', 'down');
  if (spec.mechanics.includes('shoot')) actions.push('fire');
  if (spec.mechanics.includes('dash')) actions.push('dash');
  return actions.map((action) => ({
    action,
    keys: KEYS[action] ?? action,
    description: `${action} control`,
  }));
}

function levelIntent(level: LevelData, index: number, total: number): string {
  if (index === 0) return 'Teach the core loop with generous spacing and one readable obstacle.';
  if (index === total - 1) return 'Combine the mechanics under pressure before the final exit.';
  return level.enemies.length > 0
    ? 'Introduce overlapping timing between patrols and gaps.'
    : 'Extend the traversal chain and raise the height changes.';
}

export function buildDesignPlan(input: {
  spec: GameSpec;
  blueprint: Pick<GameBlueprint, 'levels' | 'palette' | 'mechanics' | 'controls'>;
  modelAssisted: boolean;
  narrative?: { logline?: string; pillars?: string[] };
}): GameDesignPlan {
  const { spec, blueprint } = input;
  const mechanics = blueprint.mechanics.map((id) => ({
    id,
    purpose: MECHANIC_PURPOSE[id].purpose,
    systems: [...MECHANIC_PURPOSE[id].systems],
  }));

  const scoring = [
    { event: 'collectible', points: 10 },
    { event: 'enemy defeated', points: 50 },
    { event: 'level cleared', points: 100 },
  ];

  return {
    title: titleFromPrompt(spec.prompt),
    logline:
      input.narrative?.logline ??
      `${spec.prompt} A ${spec.genre.replace(/_/g, ' ')} played from the ${spec.camera.replace(/_/g, ' ')} camera across ${spec.levels} level${spec.levels === 1 ? '' : 's'}.`,
    pillars:
      input.narrative?.pillars?.slice(0, 6) ??
      [
        'Readable movement: every gap and ledge is clear at a glance.',
        'Composed mechanics: the build contains exactly the systems the spec names.',
        'Verified playability: a deterministic bot must finish every level before a build counts.',
      ],
    mechanics,
    levelArc: blueprint.levels.map((level, index) => ({
      index: index + 1,
      name: level.name,
      intent: levelIntent(level, index, blueprint.levels.length),
    })),
    controls: blueprint.controls.map((control) => ({
      action: control.action as GameDesignPlan['controls'][number]['action'],
      keys: control.keys,
      description: control.description,
    })),
    scoring,
    art: {
      palette: [...blueprint.palette],
      style: spec.artDirection,
    },
    assets: [
      { id: 'theme', kind: 'sprite', purpose: 'Original decorative backdrop generated for this palette.', license: 'generated-original' },
      { id: 'player', kind: 'sprite', purpose: 'Procedural player silhouette drawn from palette indices.', license: 'generated-original' },
      { id: 'tiles', kind: 'tile', purpose: 'Solid, hazard and pickup tiles drawn from palette indices.', license: 'generated-original' },
    ],
    risks:
      spec.camera === 'first_person'
        ? ['No deterministic first-person projection exists in this generator.']
        : [],
    modelAssisted: input.modelAssisted,
  };
}

function titleFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 4);
  const title = words.length > 0 ? words.join(' ') : 'Untitled Game';
  return title.slice(0, 120);
}
