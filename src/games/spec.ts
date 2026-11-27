import type {
  GameCamera,
  GameGenre,
  GameMechanic,
  GameSpec,
} from '@coderax/contracts';
import { GAME_CAMERAS, GAME_GENRES, GAME_MECHANICS } from '@coderax/contracts';
import { seedFrom } from './random.js';
import { isSupportedCamera } from './types.js';

/**
 * Natural-language specification interpretation.
 *
 * This is a deterministic reader, not a model pretending to understand. It maps
 * explicit words in the prompt to the same fields a client can set directly, and
 * a configured zero-cost model may refine only the prose fields, whose output is
 * validated against the schema before use. When no model is configured the
 * deterministic path is the whole path, and the build still works.
 */

const GENRE_WORDS: Array<{ genre: GameGenre; words: string[] }> = [
  { genre: 'platformer', words: ['platformer', 'platform', 'jump', 'run and jump', 'rooftop'] },
  { genre: 'puzzle', words: ['puzzle', 'route', 'circuit', 'logic', 'tile', 'garden'] },
  { genre: 'arcade', words: ['arcade', 'high score', 'endless', 'wave'] },
  { genre: 'shooter', words: ['shooter', 'shoot', 'blaster', 'drone', 'bullet'] },
  { genre: 'strategy', words: ['strategy', 'manage', 'harbor', 'economy', 'plan', 'tactics'] },
  { genre: 'adventure', words: ['adventure', 'explore', 'exploration', 'dungeon', 'maze'] },
  { genre: 'role_playing', words: ['role playing', 'rpg', 'quest', 'hero'] },
];

const CAMERA_WORDS: Array<{ camera: GameCamera; words: string[] }> = [
  { camera: 'side_view', words: ['side view', 'side-view', 'sideways', 'platformer'] },
  { camera: 'top_down', words: ['top down', 'top-down', 'overhead', 'bird'] },
  { camera: 'isometric', words: ['isometric', 'iso'] },
  { camera: 'ui_only', words: ['grid', 'menu', 'board'] },
  { camera: 'first_person', words: ['first person', 'first-person', 'fps'] },
];

const MECHANIC_WORDS: Array<{ mechanic: GameMechanic; words: string[] }> = [
  { mechanic: 'gravity', words: ['gravity', 'fall', 'platformer'] },
  { mechanic: 'jump', words: ['jump', 'leap', 'platformer'] },
  { mechanic: 'double_jump', words: ['double jump', 'air jump'] },
  { mechanic: 'dash', words: ['dash', 'sprint', 'burst'] },
  { mechanic: 'shoot', words: ['shoot', 'fire', 'blaster', 'projectile'] },
  { mechanic: 'enemies', words: ['enemy', 'enemies', 'guard', 'patrol', 'drone'] },
  { mechanic: 'hazards', words: ['hazard', 'spike', 'trap', 'danger', 'electric'] },
  { mechanic: 'collectibles', words: ['collect', 'coin', 'pickup', 'lantern', 'oil', 'cargo'] },
  { mechanic: 'moving_platforms', words: ['moving platform', 'lift', 'conveyor'] },
  { mechanic: 'push_blocks', words: ['push', 'crate', 'block'] },
  { mechanic: 'switches', words: ['switch', 'lever', 'beacon', 'node', 'relight'] },
  { mechanic: 'timer', words: ['timer', 'time limit', 'before night', 'countdown', 'deadline'] },
];

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

const GENRE_DEFAULTS: Record<GameGenre, GameMechanic[]> = {
  platformer: ['gravity', 'jump', 'collectibles', 'hazards', 'enemies'],
  puzzle: ['collectibles', 'switches', 'push_blocks'],
  arcade: ['shoot', 'enemies', 'hazards', 'collectibles'],
  shooter: ['shoot', 'enemies', 'hazards', 'collectibles'],
  strategy: ['collectibles', 'enemies', 'switches'],
  adventure: ['collectibles', 'enemies', 'switches', 'hazards'],
  role_playing: ['gravity', 'jump', 'collectibles', 'enemies', 'switches'],
  other: ['gravity', 'jump', 'collectibles'],
};

function uniqueMechanics(values: GameMechanic[]): GameMechanic[] {
  return GAME_MECHANICS.filter((mechanic) => values.includes(mechanic));
}

export function interpretPrompt(prompt: string): GameSpec {
  const text = prompt.toLowerCase();
  const genre =
    GENRE_WORDS.find((entry) => includesAny(text, entry.words))?.genre ?? 'platformer';

  const cameraFromWords = CAMERA_WORDS.find((entry) => includesAny(text, entry.words))?.camera;
  const camera: GameCamera =
    cameraFromWords ?? (genre === 'platformer' ? 'side_view' : 'top_down');

  const mechanics = new Set<GameMechanic>(GENRE_DEFAULTS[genre]);
  for (const entry of MECHANIC_WORDS) {
    if (includesAny(text, entry.words)) mechanics.add(entry.mechanic);
  }
  // Gravity and jump are only meaningful in a side view.
  if (camera !== 'side_view') {
    mechanics.delete('gravity');
    mechanics.delete('jump');
    mechanics.delete('double_jump');
  } else {
    mechanics.add('gravity');
    mechanics.add('jump');
  }

  const difficulty = /\b(hard|harder|brutal|intense|difficult)\b/.test(text)
    ? 4
    : /\b(easy|calm|gentle|relaxing|chill)\b/.test(text)
      ? 1
      : 2;

  const levelsMatch = /\b([1-8])\s*(?:levels|stages|rooms)\b/.exec(text);
  const levels = levelsMatch ? Number(levelsMatch[1]) : 3;

  const winCondition = /win|reach|clear|survive|before|goal/.test(text)
    ? `Complete every level: ${prompt.trim()}`
    : 'Reach the goal in every level.';

  return {
    prompt: prompt.trim(),
    genre,
    camera,
    players: 1,
    difficulty,
    mechanics: uniqueMechanics([...mechanics]),
    levels,
    seed: seedFrom(prompt),
    coreLoop: `Traverse each level, use ${[...mechanics].join(', ')} to make progress, and reach the exit.`,
    winCondition,
    artDirection: artDirectionFor(genre),
  };
}

function artDirectionFor(genre: GameGenre): string {
  switch (genre) {
    case 'puzzle':
      return 'Soft engineered palette, copper traces, calm readable silhouettes.';
    case 'arcade':
      return 'Bright high-contrast palette, bold targets, instantly readable action.';
    case 'adventure':
      return 'Warm explorable palette, distinct landmarks, calm silhouettes.';
    case 'shooter':
      return 'High-contrast space palette, bright projectiles, minimal HUD.';
    case 'strategy':
      return 'Flat maritime palette, clear berth markers, restrained motion.';
    case 'role_playing':
      return 'Warm lantern light, muted dusk tones, simple geometric figures.';
    default:
      return 'Muted atmospheric palette, strong silhouettes, readable foreground.';
  }
}

const PALETTES: Record<GameGenre, string[][]> = {
  platformer: [
    ['#141a2b', '#26324d', '#f2b35c', '#e05c4b', '#7fd1b9', '#f5f0e1'],
    ['#1b2430', '#33506b', '#ffd166', '#ef476f', '#06d6a0', '#eef4ed'],
  ],
  puzzle: [
    ['#0f1f1a', '#1e3b30', '#8fd694', '#c98b4b', '#e8f3e7', '#5aa9a3'],
    ['#111827', '#27364a', '#7dd3fc', '#fbbf24', '#e5e7eb', '#34d399'],
  ],
  arcade: [
    ['#0b0b1a', '#241b45', '#ffd60a', '#ff4d6d', '#4cc9f0', '#f8f9fa'],
    ['#140f1f', '#33204f', '#7bf1a8', '#ff9f1c', '#5bc0eb', '#fdfcdc'],
  ],
  shooter: [
    ['#050912', '#101a33', '#4cc9f0', '#f72585', '#ffd60a', '#e8eaf6'],
    ['#0a0a14', '#1b1b2f', '#00e5ff', '#ff4d6d', '#c6ff00', '#f8f9fa'],
  ],
  strategy: [
    ['#0b1c24', '#15414f', '#f4a261', '#2a9d8f', '#e9c46a', '#f1faee'],
    ['#12161a', '#23303a', '#ffb703', '#8ecae6', '#fb8500', '#f8f9fa'],
  ],
  adventure: [
    ['#15130f', '#2f2a1f', '#e9c46a', '#b23a48', '#7f9c6c', '#f7f3e8'],
    ['#101614', '#24352c', '#f4d35e', '#d1495b', '#66a182', '#fefae0'],
  ],
  role_playing: [
    ['#191324', '#2d2140', '#f4d35e', '#9b5de5', '#f15bb5', '#fefae0'],
    ['#201a16', '#3a2c22', '#e9c46a', '#d1495b', '#66a182', '#f7f3e8'],
  ],
  other: [
    ['#101418', '#232c33', '#f2c14e', '#e4572e', '#76b041', '#f4f1de'],
  ],
};

export function paletteFor(genre: GameGenre, seed: number): string[] {
  const options = PALETTES[genre] ?? PALETTES.other;
  return [...(options[seed % options.length] as string[])];
}

export type SpecValidation =
  | { ok: true }
  | { ok: false; code: 'unsupported_camera' | 'unsupported_players'; detail: string };

/** Build-time admission. A saved spec may hold a value this deployment cannot build. */
export function validateBuildableSpec(spec: GameSpec): SpecValidation {
  if (!isSupportedCamera(spec.camera)) {
    return {
      ok: false,
      code: 'unsupported_camera',
      detail: `The ${spec.camera} camera has no verified deterministic projection in this generator.`,
    };
  }
  if (spec.players !== 1) {
    return {
      ok: false,
      code: 'unsupported_players',
      detail: 'Local two-player co-op is not implemented, so the spec cannot be built as two players.',
    };
  }
  return { ok: true };
}

export type SpecEdit = { spec: GameSpec; changes: string[] };

/**
 * Iterative editing: a natural-language instruction maps to explicit spec
 * changes. An unrecognised instruction is refused with the supported intents
 * instead of silently rebuilding a different game.
 */
export function applyInstruction(spec: GameSpec, instruction: string): SpecEdit | null {
  const text = instruction.toLowerCase();
  const next: GameSpec = { ...spec, mechanics: [...spec.mechanics] };
  const changes: string[] = [];

  const addMechanic = (mechanic: GameMechanic, label: string): void => {
    if (!next.mechanics.includes(mechanic)) {
      next.mechanics.push(mechanic);
      next.mechanics = GAME_MECHANICS.filter((entry) => next.mechanics.includes(entry));
      changes.push(`Added ${label}.`);
    }
  };
  const removeMechanic = (mechanic: GameMechanic, label: string): void => {
    if (next.mechanics.includes(mechanic)) {
      next.mechanics = next.mechanics.filter((entry) => entry !== mechanic);
      changes.push(`Removed ${label}.`);
    }
  };

  if (/\bharder\b|\bmore difficult\b|\bbrutal\b/.test(text) && next.difficulty < 5) {
    next.difficulty += 1;
    changes.push(`Raised difficulty to ${next.difficulty}.`);
  }
  if (/\beasier\b|\bmore forgiving\b|\bcalmer\b/.test(text) && next.difficulty > 1) {
    next.difficulty -= 1;
    changes.push(`Lowered difficulty to ${next.difficulty}.`);
  }
  if (/\bmore levels\b|\blonger\b|\bextra levels\b/.test(text) && next.levels < 8) {
    next.levels += 1;
    changes.push(`Increased level count to ${next.levels}.`);
  }
  if (/\bfewer levels\b|\bshorter\b/.test(text) && next.levels > 1) {
    next.levels -= 1;
    changes.push(`Reduced level count to ${next.levels}.`);
  }
  if (/\badd (?:an? )?(?:enemy|enemies)\b|\bmore enemies\b/.test(text)) {
    addMechanic('enemies', 'enemy patrols');
  }
  if (/\bremove (?:the )?enemies\b|\bno enemies\b/.test(text)) {
    removeMechanic('enemies', 'enemy patrols');
  }
  if (/\badd (?:a )?timer\b|\btime limit\b|\bcountdown\b/.test(text)) {
    addMechanic('timer', 'a level timer');
  }
  if (/\bremove (?:the )?timer\b|\bno time limit\b/.test(text)) {
    removeMechanic('timer', 'the level timer');
  }
  if (/\bdouble jump\b/.test(text)) addMechanic('double_jump', 'double jump');
  if (/\bdash\b/.test(text)) addMechanic('dash', 'dash movement');
  if (/\bshoot|\bfire\b|\bprojectile\b/.test(text)) addMechanic('shoot', 'projectiles');
  if (/\bmoving platform|\blift\b/.test(text)) {
    addMechanic('moving_platforms', 'moving platforms');
  }
  if (/\bpush(?:able)? (?:block|crate)|\bcrate\b/.test(text)) {
    addMechanic('push_blocks', 'pushable blocks');
  }
  if (/\bswitch|\blever\b/.test(text)) addMechanic('switches', 'goal switches');

  if (/\bpuzzle\b/.test(text) && next.genre !== 'puzzle') {
    next.genre = 'puzzle';
    changes.push('Changed the genre to puzzle.');
  }
  if (/\barcade\b/.test(text) && next.genre !== 'arcade') {
    next.genre = 'arcade';
    changes.push('Changed the genre to arcade.');
  }
  if (/\badventure\b/.test(text) && next.genre !== 'adventure') {
    next.genre = 'adventure';
    changes.push('Changed the genre to adventure.');
  }
  if (/\bshooter\b/.test(text) && next.genre !== 'shooter') {
    next.genre = 'shooter';
    changes.push('Changed the genre to shooter.');
  }
  if (/\bplatformer\b/.test(text) && next.genre !== 'platformer') {
    next.genre = 'platformer';
    changes.push('Changed the genre to platformer.');
  }
  if (/\bplatformer\b/.test(text) && next.camera !== 'side_view') {
    next.camera = 'side_view';
    changes.push('Switched to the side-view camera.');
  }
  if (/\b(?:arcade|adventure)\b/.test(text) && next.camera === 'side_view') {
    next.camera = 'top_down';
    changes.push('Switched to the top-down camera for exploration.');
  }
  if (/\btop[- ]down\b/.test(text) && next.camera !== 'top_down') {
    next.camera = 'top_down';
    changes.push('Switched to the top-down camera.');
  }
  if (/\bisometric\b/.test(text) && next.camera !== 'isometric') {
    next.camera = 'isometric';
    changes.push('Switched to the isometric camera.');
  }
  if (/\bregen(?:erate)?\b|\bnew layout\b|\breseed\b|\brearrange\b/.test(text)) {
    next.seed = (Math.imul(next.seed ^ seedFrom(instruction), 1664525) >>> 0) % 2_147_483_647;
    changes.push('Generated a new level layout from the instruction.');
  }

  const flavour = /^(?:make it|set it|it is|about)\s+(.{3,120})$/i.exec(instruction.trim());
  if (flavour) {
    next.artDirection = `${spec.artDirection} ${flavour[1]}`.slice(0, 2000);
    changes.push('Updated the art direction.');
  }

  if (changes.length === 0) return null;

  // Keep the mechanic set coherent with the projection: gravity, jump and double
  // jump only exist in the platformer movement model that side view implies.
  if (next.camera === 'side_view') {
    if (!next.mechanics.includes('gravity')) next.mechanics.push('gravity');
    if (!next.mechanics.includes('jump')) next.mechanics.push('jump');
    next.mechanics = GAME_MECHANICS.filter((entry) => next.mechanics.includes(entry));
  } else {
    next.mechanics = next.mechanics.filter(
      (entry) => entry !== 'gravity' && entry !== 'jump' && entry !== 'double_jump',
    );
    if (next.mechanics.length === 0) next.mechanics = ['collectibles'];
  }
  return { spec: next, changes };
}

export const SUPPORTED_EDITS = Object.freeze([
  'harder / easier',
  'more levels / fewer levels',
  'add enemies / remove enemies',
  'add a timer / remove the timer',
  'double jump, dash, shooting, moving platforms, pushable blocks, switches',
  'puzzle, shooter, arcade, adventure or platformer genre',
  'side view, top-down or isometric camera',
  'regenerate / new layout',
]);

/** Exposed for the capability report: the interpreter never claims model help. */
export const DETERMINISTIC_SPEC_FIELDS = Object.freeze([
  'genre',
  'camera',
  'difficulty',
  'mechanics',
  'levels',
  'seed',
]);

export const SUPPORTED_GENRES = GAME_GENRES;
export const SUPPORTED_CAMERAS = GAME_CAMERAS;
