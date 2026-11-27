import type { GameCamera, GameMechanic, GameSpec } from '@coderax/contracts';

/**
 * Internal blueprint shapes.
 *
 * These are deliberately separate from the HTTP contract: they describe the
 * generated world, not what a client may send. They are serialised verbatim into
 * `src/levels.js`, so a change here changes the artifacts a build produces.
 */

export type MovementModel = 'platformer' | 'top_down';

export type LevelSolid = {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'ground' | 'platform' | 'wall';
};

export type LevelHazard = { x: number; y: number; w: number; h: number };
export type LevelCollectible = { x: number; y: number; w: number; h: number; value: number };
export type LevelEnemy = {
  x: number;
  y: number;
  w: number;
  h: number;
  minX: number;
  maxX: number;
  speed: number;
};
export type LevelSwitch = { x: number; y: number; w: number; h: number };
export type LevelBlock = { x: number; y: number; w: number; h: number };
export type LevelMover = {
  x: number;
  y: number;
  w: number;
  h: number;
  axis: 'x' | 'y';
  range: number;
  speed: number;
};

export type LevelData = {
  id: string;
  name: string;
  width: number;
  height: number;
  movement: MovementModel;
  spawn: { x: number; y: number };
  solids: LevelSolid[];
  hazards: LevelHazard[];
  collectibles: LevelCollectible[];
  enemies: LevelEnemy[];
  switches: LevelSwitch[];
  blocks: LevelBlock[];
  movers: LevelMover[];
  goal: { x: number; y: number; w: number; h: number; requiresSwitch: boolean };
  timeLimit: number | null;
  scoring: { collectible: number; enemy: number; levelClear: number };
};

export type Tuning = {
  width: number;
  height: number;
  fixedStep: number;
  speed: number;
  dashSpeed: number;
  gravity: number;
  jump: number;
  health: number;
  collectiblePoints: number;
  enemyPoints: number;
  levelClearPoints: number;
};

export type GameBlueprint = {
  spec: GameSpec;
  movement: MovementModel;
  camera: GameCamera;
  mechanics: GameMechanic[];
  tuning: Tuning;
  palette: string[];
  levels: LevelData[];
  controls: Array<{ action: string; keys: string; description: string }>;
};

export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 34;

export const DEFAULT_TUNING: Tuning = {
  width: 960,
  height: 540,
  fixedStep: 1 / 60,
  speed: 260,
  dashSpeed: 520,
  gravity: 2000,
  jump: 700,
  health: 3,
  collectiblePoints: 10,
  enemyPoints: 50,
  levelClearPoints: 100,
};

/**
 * A camera maps to a movement model, not to a template. `first_person` has no
 * verified deterministic projection in this generator, so a build refuses it
 * rather than shipping a mislabeled game.
 */
export function movementForCamera(camera: GameCamera): MovementModel | null {
  if (camera === 'side_view') return 'platformer';
  if (camera === 'top_down' || camera === 'isometric' || camera === 'ui_only') return 'top_down';
  return null;
}

export function isSupportedCamera(camera: GameCamera): boolean {
  return movementForCamera(camera) !== null;
}
