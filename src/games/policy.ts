import type { GameInput, GameObjective } from '@coderax/contracts';
import type { GameBlueprint, LevelSolid } from './types.js';
import { distanceField } from './level.js';
import type { RuntimeGame } from './runtime.js';

/**
 * Objective planning and bounded control selection.
 *
 * The policy is deterministic and bounded: it reads the observed game state,
 * picks inputs from the granted action set only, and never claims an objective
 * was reached. Completion is measured by the runtime from game state; this module
 * only chooses what to press.
 */

export type PolicyMemory = {
  waypoints: Array<{ x: number; y: number }>;
  computedAtTick: number;
  waypointIndex: number;
  stuck: number;
  lastX: number;
  lastY: number;
  jumpToggle: boolean;
};

export function createPolicyMemory(): PolicyMemory {
  return {
    waypoints: [],
    computedAtTick: -1,
    waypointIndex: 0,
    stuck: 0,
    lastX: 0,
    lastY: 0,
    jumpToggle: false,
  };
}

const CELL = 40;

function isBlocked(state: RuntimeGame['state'], col: number, row: number): boolean {
  const x = col * CELL;
  const y = row * CELL;
  const box = { x: x + 2, y: y + 2, w: CELL - 4, h: CELL - 4 };
  const hits = (solid: { x: number; y: number; w: number; h: number }): boolean =>
    box.x < solid.x + solid.w && box.x + box.w > solid.x && box.y < solid.y + solid.h && box.y + box.h > solid.y;
  return (
    state.solids.some(hits) ||
    state.blocks.some(hits) ||
    state.hazards.some((hazard) => hits(hazard))
  );
}

function columnFor(x: number): number {
  return Math.max(0, Math.floor(x / CELL));
}

function rowFor(y: number): number {
  return Math.max(0, Math.floor(y / CELL));
}

function pathTo(
  game: RuntimeGame,
  target: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const level = game.level;
  // Blocks and hazards block a route even though only solids stop the physics:
  // a block pinned against a wall can never be pushed out of the way, so a path
  // through it would be a route the player can only walk into and stall on.
  const field = distanceField({
    solids: [...(level.solids as LevelSolid[]), ...game.state.blocks, ...game.state.hazards],
    width: level.width,
    height: level.height,
    from: { x: game.state.player.x, y: game.state.player.y },
  });
  const rows = field.length;
  const cols = (field[0] as number[]).length;
  const wantedRow = Math.min(rows - 1, rowFor(target.y));
  const wantedCol = Math.min(cols - 1, columnFor(target.x));

  // The goal or switch cell can be occupied or boxed in. Walk the field for the
  // reachable, unblocked cell nearest the wanted one instead of returning no
  // path, which would otherwise degrade to walking straight into a wall.
  let row = -1;
  let col = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let candidateRow = 0; candidateRow < rows; candidateRow += 1) {
    for (let candidateCol = 0; candidateCol < cols; candidateCol += 1) {
      const distance = (field[candidateRow] as number[])[candidateCol] as number;
      if (distance < 0) continue;
      if (isBlocked(game.state, candidateCol, candidateRow)) continue;
      const score =
        Math.abs(candidateRow - wantedRow) * CELL + Math.abs(candidateCol - wantedCol) * CELL;
      const current = row < 0 ? Number.POSITIVE_INFINITY : ((field[row] as number[])[col] as number);
      if (score < best || (score === best && distance < current)) {
        best = score;
        row = candidateRow;
        col = candidateCol;
      }
    }
  }
  if (row < 0 || col < 0) return [];
  const path: Array<{ x: number; y: number }> = [];
  let distance = (field[row] as number[])[col] as number;
  while (distance > 0) {
    path.push({ x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 });
    const neighbours: Array<[number, number]> = [
      [row + 1, col],
      [row - 1, col],
      [row, col + 1],
      [row, col - 1],
    ];
    let next: [number, number] | null = null;
    for (const [nextRow, nextCol] of neighbours) {
      if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols) continue;
      if ((field[nextRow] as number[])[nextCol] === distance - 1) {
        next = [nextRow, nextCol];
        break;
      }
    }
    if (!next) break;
    row = next[0];
    col = next[1];
    distance -= 1;
  }
  return path.reverse();
}

function topDownTarget(game: RuntimeGame, objective: GameObjective): { x: number; y: number } {
  const state = game.state;
  if (objective.kind === 'defeat_enemies') {
    const enemy = state.enemies.find((entry) => entry.alive);
    if (enemy) return { x: enemy.x + enemy.w / 2, y: enemy.y + enemy.h / 2 };
  }
  if (objective.kind === 'score_at_least' && state.score < objective.target) {
    const pickup = state.collectibles.find((entry) => !entry.taken);
    if (pickup) return { x: pickup.x + pickup.w / 2, y: pickup.y + pickup.h / 2 };
  }
  const offSwitch = state.switches.find((entry) => !entry.on);
  if (state.goal.locked && offSwitch) {
    return { x: offSwitch.x + offSwitch.w / 2, y: offSwitch.y + offSwitch.h / 2 };
  }
  return { x: state.goal.x + state.goal.w / 2, y: state.goal.y + state.goal.h / 2 };
}

function platformerInput(
  game: RuntimeGame,
  blueprint: GameBlueprint,
  objective: GameObjective,
): Partial<GameInput> {
  const state = game.state;
  const player = state.player;
  const right = true;
  const aheadX = player.x + player.w;

  const near = (box: { x: number; y: number; w: number; h: number }, distance: number): boolean =>
    box.x + box.w > aheadX - 8 &&
    box.x < aheadX + distance &&
    box.y + box.h > player.y + 2 &&
    box.y < player.y + player.h;

  const hazardAhead = state.hazards.some((hazard) => near(hazard, 60));
  const enemyAhead = state.enemies.some((enemy) => enemy.alive && near(enemy, 66));

  const probe = { x: aheadX + 4, y: player.y + player.h + 2, w: 18, h: 56 };
  const groundAhead = [...state.solids, ...state.movers].some(
    (solid) =>
      probe.x < solid.x + solid.w &&
      probe.x + probe.w > solid.x &&
      probe.y < solid.y + solid.h &&
      probe.y + probe.h > solid.y,
  );
  const wall = { x: aheadX + 2, y: player.y + 4, w: 6, h: player.h - 6 };
  const wallAhead = state.solids.some(
    (solid) =>
      wall.x < solid.x + solid.w &&
      wall.x + wall.w > solid.x &&
      wall.y < solid.y + solid.h &&
      wall.y + wall.h > solid.y,
  );

  // Only a grounded jump exists in the shipped physics. A jump pressed in the air
  // is ignored, and worse, it lands the runner at the next gap without a jump
  // left, so hazard avoidance must wait for a foot on the ground.
  let jump = player.onGround && (hazardAhead || enemyAhead || !groundAhead || wallAhead);

  // A floating platform is an optional route, not a launch pad: leaping from it
  // keeps the runner airborne long enough to overshoot the next gap. Walk off and
  // fall back to the main floor instead.
  const feet = { x: player.x + 2, y: player.y + player.h + 1, w: player.w - 4, h: 4 };
  const onFloor = game.level.solids.some(
    (solid) =>
      solid.kind === 'ground' &&
      feet.x < solid.x + solid.w &&
      feet.x + feet.w > solid.x &&
      feet.y < solid.y + solid.h &&
      feet.y + feet.h > solid.y,
  );
  if (player.onGround && !onFloor) jump = false;

  let fire = false;
  if (blueprint.mechanics.includes('shoot') && objective.kind !== 'reach_goal') {
    const target = state.enemies.find(
      (enemy) =>
        enemy.alive &&
        Math.abs(enemy.y - player.y) < 50 &&
        enemy.x > player.x &&
        enemy.x - player.x < 320,
    );
    fire = target !== undefined;
  } else if (blueprint.mechanics.includes('shoot')) {
    fire = state.enemies.some(
      (enemy) =>
        enemy.alive &&
        Math.abs(enemy.y - player.y) < 50 &&
        enemy.x > player.x &&
        enemy.x - player.x < 200,
    );
  }

  return {
    left: false,
    right,
    up: false,
    down: false,
    jump,
    fire,
    dash: false,
  };
}

export function chooseInput(input: {
  game: RuntimeGame;
  blueprint: GameBlueprint;
  objective: GameObjective;
  memory: PolicyMemory;
  allowedActions: readonly string[];
}): Partial<GameInput> {
  const { game, blueprint, objective, memory } = input;
  const state = game.state;

  if (blueprint.movement === 'platformer') {
    const chosen = platformerInput(game, blueprint, objective);
    return grant(chosen, input.allowedActions);
  }

  const target = topDownTarget(game, objective);
  const recompute =
    memory.computedAtTick < 0 ||
    state.tick - memory.computedAtTick > 20 ||
    memory.waypointIndex >= memory.waypoints.length;

  if (recompute) {
    memory.waypoints = pathTo(game, target);
    memory.waypointIndex = 0;
    memory.computedAtTick = state.tick;
  }

  const player = state.player;
  if (Math.abs(player.x - memory.lastX) < 0.4 && Math.abs(player.y - memory.lastY) < 0.4) {
    memory.stuck += 1;
  } else {
    memory.stuck = 0;
  }
  memory.lastX = player.x;
  memory.lastY = player.y;

  let waypoint = memory.waypoints[memory.waypointIndex];
  if (!waypoint) waypoint = target;
  const dx = waypoint.x - (player.x + player.w / 2);
  const dy = waypoint.y - (player.y + player.h / 2);
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
    memory.waypointIndex += 1;
  }

  const chosen: Partial<GameInput> = {
    left: dx < -4,
    right: dx > 4,
    up: dy < -4,
    down: dy > 4,
    jump: false,
    fire: false,
    dash: false,
  };

  if (memory.stuck > 12) {
    // Wall-slide: drop the stale route, sidestep on the axis the route does not
    // use, and let the next tick plan again from the new cell.
    memory.computedAtTick = -1;
    if (Math.abs(dx) >= Math.abs(dy)) {
      chosen.up = memory.stuck % 20 < 10;
      chosen.down = !chosen.up;
    } else {
      chosen.left = memory.stuck % 20 >= 10;
      chosen.right = !chosen.left;
    }
  }

  return grant(chosen, input.allowedActions);
}

/** The policy can only ever press granted actions. */
function grant(
  input: Partial<GameInput>,
  allowedActions: readonly string[],
): Partial<GameInput> {
  const granted: Partial<GameInput> = {};
  for (const action of allowedActions) {
    if (action in input) (granted as Record<string, unknown>)[action] = (input as Record<string, unknown>)[action];
  }
  return granted;
}

export function planSteps(objective: GameObjective): Array<{ id: string; title: string }> {
  const goal =
    objective.kind === 'score_at_least'
      ? `Collect at least ${objective.target} points`
      : objective.kind === 'defeat_enemies'
        ? `Defeat ${objective.target} enemies`
        : objective.kind === 'complete_levels'
          ? `Clear ${objective.target} levels`
          : 'Reach the exit of every level';
  return [
    { id: 'observe', title: 'Observe the current frame and measured game state' },
    { id: 'plan', title: `Plan a bounded route: ${goal}` },
    { id: 'play', title: 'Play with the granted controls and record evidence' },
    { id: 'verify', title: 'Verify the objective from measured game state' },
  ];
}
