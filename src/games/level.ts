import type { GameSpec } from '@coderax/contracts';
import { createRandom, integer, levelSeed, pick } from './random.js';
import {
  DEFAULT_TUNING,
  movementForCamera,
  PLAYER_HEIGHT,
  type LevelBlock,
  type LevelCollectible,
  type LevelData,
  type LevelEnemy,
  type LevelHazard,
  type LevelMover,
  type LevelSolid,
  type LevelSwitch,
  type MovementModel,
} from './types.js';

/**
 * Deterministic level construction.
 *
 * Levels are generated from the spec's seed and difficulty, then constrained by
 * the physics the build actually ships: a step may not exceed the measured jump
 * height, a gap may not exceed the measured jump distance, and a top-down exit is
 * placed only on a cell reachable from the spawn. That is why verification can
 * require the bot to finish every level rather than hoping it can.
 */

const GROUND = 420;
const WORLD_HEIGHT = 540;
const CELL = 40;

const JUMP_HEIGHT = (DEFAULT_TUNING.jump * DEFAULT_TUNING.jump) / (2 * DEFAULT_TUNING.gravity);
const AIR_TIME = (2 * DEFAULT_TUNING.jump) / DEFAULT_TUNING.gravity;
const JUMP_DISTANCE = DEFAULT_TUNING.speed * AIR_TIME;

const MAX_STEP = Math.floor(JUMP_HEIGHT * 0.65);
const MAX_GAP = Math.floor(JUMP_DISTANCE * 0.6);

type Slab = { x: number; y: number; w: number };

function slabSolid(slab: Slab): LevelSolid {
  return {
    x: slab.x,
    y: slab.y,
    w: slab.w,
    h: WORLD_HEIGHT - slab.y + 220,
    kind: 'ground',
  };
}

function platform(x: number, y: number, w: number): LevelSolid {
  return { x, y, w, h: 16, kind: 'platform' };
}

function platformerLevel(
  spec: GameSpec,
  index: number,
  id: string,
  name: string,
): LevelData {
  const random = createRandom(levelSeed(spec.seed, index));
  const width = 1500 + index * 260 + spec.difficulty * 140;
  const mechanics = new Set(spec.mechanics);
  const solids: LevelSolid[] = [];
  const slabs: Slab[] = [];

  let x = 0;
  let top = GROUND;
  while (x < width - 420) {
    const slabWidth = integer(random, 220, 360);
    slabs.push({ x, y: top, w: slabWidth });
    solids.push(slabSolid({ x, y: top, w: slabWidth }));
    x += slabWidth;
    if (x < width - 460) {
      const gap = spec.difficulty >= 2 ? integer(random, 50, Math.min(110, MAX_GAP)) : 0;
      x += gap;
      const stepChoices = [-MAX_STEP, -Math.floor(MAX_STEP / 2), 0, 0, Math.floor(MAX_STEP / 2)];
      top = Math.min(GROUND + 40, Math.max(GROUND - 200, top + pick(random, stepChoices)));
    }
  }
  slabs.push({ x, y: top, w: width - x });
  solids.push(slabSolid({ x, y: top, w: width - x }));

  const hazards: LevelHazard[] = [];
  const collectibles: LevelCollectible[] = [];
  const enemies: LevelEnemy[] = [];
  const switches: LevelSwitch[] = [];
  const blocks: LevelBlock[] = [];
  const movers: LevelMover[] = [];

  const lastIndex = slabs.length - 1;
  const spawnSlab = slabs[0] as Slab;
  const goalSlab = slabs[lastIndex] as Slab;

  const spawn = { x: 40, y: spawnSlab.y - PLAYER_HEIGHT };
  const goal = {
    x: goalSlab.x + goalSlab.w - 90,
    y: goalSlab.y - 48,
    w: 40,
    h: 48,
    requiresSwitch: mechanics.has('switches') && switches.length >= 0,
  };

  // The switch sits on the spawn slab, where the walking route is guaranteed
  // to cross it. A switch placed near a gap can be jumped over, which would make
  // the exit unreachable for a runner and would not be an honest lock.
  if (mechanics.has('switches') && spawnSlab.w > 220) {
    switches.push({ x: spawnSlab.x + Math.round(spawnSlab.w * 0.55), y: spawnSlab.y - 26, w: 26, h: 26 });
    goal.requiresSwitch = true;
  } else {
    goal.requiresSwitch = false;
  }

  // A mechanic in the spec must exist in the build, so a wide slab always carries
  // at least one pushable block. Random placement alone can miss every level.
  if (mechanics.has('push_blocks') && blocks.length === 0) {
    const host = slabs.find((slab) => slab.w > 240) ?? spawnSlab;
    // Kept clear of the spawn-slab switch so the player can stand on it.
    blocks.push({ x: host.x + 40, y: host.y - 40, w: 40, h: 40 });
  }

  for (let slabIndex = 0; slabIndex <= lastIndex; slabIndex += 1) {
    const slab = slabs[slabIndex] as Slab;
    if (slabIndex > 0) {
      if (mechanics.has('collectibles')) {
        collectibles.push({
          x: slab.x + Math.min(70, slab.w / 2),
          y: slab.y - 56,
          w: 18,
          h: 18,
          value: 10,
        });
      }
      if (mechanics.has('hazards') && slabIndex < lastIndex && slab.w > 260 && random() < 0.45) {
        hazards.push({ x: slab.x + Math.floor(slab.w / 2), y: slab.y - 18, w: 54, h: 18 });
      }
      if (mechanics.has('enemies') && slabIndex < lastIndex && slab.w > 220 && random() < 0.5) {
        const start = slab.x + 60;
        enemies.push({
          x: start,
          y: slab.y - 30,
          w: 26,
          h: 30,
          minX: slab.x + 30,
          maxX: slab.x + slab.w - 60,
          speed: 34 + spec.difficulty * 6,
        });
      }
      if (mechanics.has('push_blocks') && slabIndex === Math.floor(lastIndex / 2) && slab.w > 300) {
        blocks.push({ x: slab.x + 100, y: slab.y - 40, w: 40, h: 40 });
      }
      if (mechanics.has('moving_platforms') && slabIndex % 2 === 0 && slab.w > 240) {
        movers.push({
          x: slab.x + 60,
          y: slab.y - 120,
          w: 90,
          h: 14,
          axis: 'x',
          range: Math.min(120, slab.w / 2),
          speed: 0.02 + spec.difficulty * 0.004,
        });
      }
    }
  }

  // Floating platforms add optional routes with a pickup on top; they never
  // replace the walked path, so a missed jump cannot make a level impossible.
  if (mechanics.has('collectibles')) {
    for (let i = 1; i < lastIndex; i += 2) {
      const slab = slabs[i] as Slab;
      const platformY = Math.max(60, slab.y - Math.floor(JUMP_HEIGHT * 0.8));
      const ledge = platform(slab.x + 40, platformY, 100);
      solids.push(ledge);
      collectibles.push({ x: ledge.x + 40, y: platformY - 28, w: 18, h: 18, value: 10 });
    }
  }

  // The spawn and the exit must stay clear of generated danger.
  const clearOf = (box: { x: number; y: number; w: number; h: number }, zones: Slab[]): boolean =>
    zones.every((zone) => box.x + box.w < zone.x || box.x > zone.x + zone.w);

  const guarded = hazards.filter((hazard) => clearOf(hazard, [spawnSlab, goalSlab]));
  const guardedEnemies = enemies.filter((enemy) => clearOf(enemy, [spawnSlab, goalSlab]));

  return {
    id,
    name,
    width,
    height: WORLD_HEIGHT,
    movement: 'platformer',
    spawn,
    solids,
    hazards: guarded,
    collectibles,
    enemies: guardedEnemies,
    switches,
    blocks,
    movers,
    goal,
    timeLimit: mechanics.has('timer') ? 120 : null,
    scoring: { collectible: 10, enemy: 50, levelClear: 100 },
  };
}

function blockedCells(
  solids: Array<{ x: number; y: number; w: number; h: number }>,
  width: number,
  height: number,
): { blocked: boolean[][]; cols: number; rows: number } {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const blocked: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
  for (const solid of solids) {
    const minCol = Math.max(0, Math.floor(solid.x / CELL));
    const maxCol = Math.min(cols - 1, Math.floor((solid.x + solid.w - 1) / CELL));
    const minRow = Math.max(0, Math.floor(solid.y / CELL));
    const maxRow = Math.min(rows - 1, Math.floor((solid.y + solid.h - 1) / CELL));
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        (blocked[row] as boolean[])[col] = true;
      }
    }
  }
  return { blocked, cols, rows };
}

/** Breadth-first distance field used by generation and by the top-down policy. */
export function distanceField(input: {
  solids: Array<{ x: number; y: number; w: number; h: number }>;
  width: number;
  height: number;
  from: { x: number; y: number };
}): number[][] {
  const { blocked, cols, rows } = blockedCells(input.solids, input.width, input.height);
  const distances: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(-1));
  const startCol = Math.min(cols - 1, Math.max(0, Math.floor(input.from.x / CELL)));
  const startRow = Math.min(rows - 1, Math.max(0, Math.floor(input.from.y / CELL)));
  if ((blocked[startRow] as boolean[])[startCol]) return distances;
  const queue: Array<[number, number]> = [[startRow, startCol]];
  (distances[startRow] as number[])[startCol] = 0;
  let head = 0;
  while (head < queue.length) {
    const [row, col] = queue[head] as [number, number];
    head += 1;
    const current = (distances[row] as number[])[col] as number;
    const neighbours: Array<[number, number]> = [
      [row + 1, col],
      [row - 1, col],
      [row, col + 1],
      [row, col - 1],
    ];
    for (const [nextRow, nextCol] of neighbours) {
      if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols) continue;
      if ((blocked[nextRow] as boolean[])[nextCol]) continue;
      if ((distances[nextRow] as number[])[nextCol] !== -1) continue;
      (distances[nextRow] as number[])[nextCol] = current + 1;
      queue.push([nextRow, nextCol]);
    }
  }
  return distances;
}

function topDownLevel(
  spec: GameSpec,
  index: number,
  id: string,
  name: string,
): LevelData {
  const random = createRandom(levelSeed(spec.seed, index) ^ 0x9e3779b9);
  const width = 1200;
  const height = 800;
  const mechanics = new Set(spec.mechanics);
  const wall = 20;

  const solids: LevelSolid[] = [
    { x: 0, y: 0, w: width, h: wall, kind: 'wall' },
    { x: 0, y: height - wall, w: width, h: wall, kind: 'wall' },
    { x: 0, y: 0, w: wall, h: height, kind: 'wall' },
    { x: width - wall, y: 0, w: wall, h: height, kind: 'wall' },
  ];

  const spawn = { x: 60, y: 60 };

  const obstacleCount = 4 + spec.difficulty * 2 + index;
  for (let attempt = 0; attempt < obstacleCount * 4 && solids.length < obstacleCount + 4; attempt += 1) {
    const w = integer(random, 80, 180);
    const h = integer(random, 80, 180);
    const x = integer(random, 120, width - 260);
    const y = integer(random, 120, height - 260);
    const candidate: LevelSolid = { x, y, w, h, kind: 'platform' };
    const tooCloseToSpawn = x < spawn.x + 140 || y < spawn.y + 140;
    const overlaps = solids.some(
      (solid) =>
        candidate.x < solid.x + solid.w + 100 &&
        candidate.x + candidate.w + 100 > solid.x &&
        candidate.y < solid.y + solid.h + 100 &&
        candidate.y + candidate.h + 100 > solid.y,
    );
    if (tooCloseToSpawn || overlaps) continue;
    solids.push(candidate);
  }

  const field = distanceField({ solids, width, height, from: spawn });
  const rows = field.length;
  const cols = (field[0] as number[]).length;

  let goalCell: { row: number; col: number; distance: number } | null = null;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const distance = (field[row] as number[])[col] as number;
      if (distance < 6) continue;
      if (!goalCell || distance > goalCell.distance) goalCell = { row, col, distance };
    }
  }
  const goalRow = goalCell?.row ?? rows - 2;
  const goalCol = goalCell?.col ?? cols - 3;
  const goal = {
    x: goalCol * CELL + 4,
    y: goalRow * CELL + 4,
    w: 32,
    h: 32,
    requiresSwitch: false,
  };

  const reachable: Array<{ row: number; col: number; distance: number }> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const distance = (field[row] as number[])[col] as number;
      if (distance >= 4) reachable.push({ row, col, distance });
    }
  }

  const collectibles: LevelCollectible[] = [];
  const enemies: LevelEnemy[] = [];
  const hazards: LevelHazard[] = [];
  const blocks: LevelBlock[] = [];
  const switches: LevelSwitch[] = [];

  const occupied = new Set<string>();

  const takeCell = (minDistance: number): { row: number; col: number } | null => {
    const candidates = reachable.filter((cell) => cell.distance >= minDistance);
    for (let attempt = 0; attempt < 60 && candidates.length > 0; attempt += 1) {
      const cell = pick(random, candidates);
      const key = `${cell.row}:${cell.col}`;
      if (occupied.has(key)) continue;
      if (Math.abs(cell.row - goalRow) < 1 && Math.abs(cell.col - goalCol) < 1) continue;
      occupied.add(key);
      return cell;
    }
    return null;
  };

  if (mechanics.has('collectibles')) {
    const count = 3 + spec.difficulty + index;
    for (let i = 0; i < count; i += 1) {
      const cell = takeCell(3);
      if (!cell) break;
      collectibles.push({
        x: cell.col * CELL + 10,
        y: cell.row * CELL + 10,
        w: 18,
        h: 18,
        value: 10,
      });
    }
  }

  if (mechanics.has('hazards')) {
    const count = spec.difficulty + index;
    for (let i = 0; i < count; i += 1) {
      const cell = takeCell(8);
      if (!cell) break;
      hazards.push({ x: cell.col * CELL + 4, y: cell.row * CELL + 4, w: 30, h: 30 });
    }
  }

  if (mechanics.has('enemies')) {
    const count = 1 + spec.difficulty;
    for (let i = 0; i < count; i += 1) {
      const cell = takeCell(6);
      if (!cell) break;
      const centerX = cell.col * CELL + 6;
      const centerY = cell.row * CELL + 6;
      enemies.push({
        x: centerX,
        y: centerY,
        w: 24,
        h: 24,
        minX: Math.max(wall, centerX - 50),
        maxX: Math.min(width - wall - 24, centerX + 50),
        speed: 26 + spec.difficulty * 5,
      });
    }
  }

  if (mechanics.has('push_blocks')) {
    for (let i = 0; i < 2; i += 1) {
      const cell = takeCell(5);
      if (!cell) break;
      blocks.push({ x: cell.col * CELL + 2, y: cell.row * CELL + 2, w: 36, h: 36 });
    }
  }

  if (mechanics.has('switches')) {
    const cell = takeCell(6);
    if (cell) {
      switches.push({ x: cell.col * CELL + 8, y: cell.row * CELL + 8, w: 24, h: 24 });
      goal.requiresSwitch = true;
    }
  }

  return {
    id,
    name,
    width,
    height,
    movement: 'top_down',
    spawn,
    solids,
    hazards,
    collectibles,
    enemies,
    switches,
    blocks,
    movers: [],
    goal,
    timeLimit: mechanics.has('timer') ? 150 : null,
    scoring: { collectible: 10, enemy: 50, levelClear: 100 },
  };
}

export function levelName(index: number, movement: MovementModel): string {
  const names =
    movement === 'platformer'
      ? ['First Steps', 'Broken Ledges', 'High Route', 'Last Light', 'Long Fall', 'Final Span', 'Night Run', 'Summit']
      : ['Open Floor', 'Crossed Paths', 'Tight Corners', 'Deep Route', 'Narrow Field', 'Last Door', 'Circuit', 'Center'];
  return names[index % names.length] as string;
}

export function generateLevels(spec: GameSpec): LevelData[] {
  const movement = movementForCamera(spec.camera);
  if (!movement) throw new Error(`camera ${spec.camera} has no movement model`);
  const levels: LevelData[] = [];
  for (let index = 0; index < spec.levels; index += 1) {
    const name = levelName(index, movement);
    if (movement === 'platformer') {
      levels.push(platformerLevel(spec, index, `level-${index + 1}`, name));
    } else {
      levels.push(topDownLevel(spec, index, `level-${index + 1}`, name));
    }
  }
  return levels;
}
