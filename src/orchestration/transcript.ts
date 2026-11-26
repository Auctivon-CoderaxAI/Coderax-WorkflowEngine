import type { AgentHistoryTurn } from '../agents/types.js';
import type { StoredMessage } from '../domain.js';

export type TranscriptLimits = {
  /** Turns kept; the newest are kept first. */
  maxTurns?: number;
  /** Characters kept across the kept turns. */
  maxChars?: number;
};

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_CHARS = 8_000;

function clamp(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function clip(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  if (limit === 1) return '…';
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Builds the history an agent sees for a follow-up turn.
 *
 * The conversation store is the only source, so a restarted process or another
 * replica produces the same history: nothing is remembered in memory. Three
 * rules keep it honest:
 *
 * - only completed `user` and `assistant` turns are included. A `tool` row is not
 *   a message the owner sent or the agent said, and an `unfinished` assistant row
 *   is a partial answer that would read as a completed one.
 * - the current turn is dropped, because it is passed separately as the
 *   objective; repeating it would ask the model to answer it twice.
 * - the oldest turns are dropped before the newest, and a single oversized
 *   newest turn is clipped rather than dropped, so the most recent exchange
 *   always survives the budget.
 */
export function buildTranscript(
  input: { messages: StoredMessage[]; currentText?: string } & TranscriptLimits,
): AgentHistoryTurn[] {
  const maxTurns = clamp(input.maxTurns ?? DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS);
  const maxChars = clamp(input.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);

  const turns: AgentHistoryTurn[] = [];
  for (const message of input.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.unfinished === true) continue;
    const text = message.text.trim();
    if (text.length === 0) continue;
    turns.push({ role: message.role, text });
  }

  const current = input.currentText?.trim();
  const newest = turns.at(-1);
  if (current && newest && newest.role === 'user' && newest.text === current) {
    turns.pop();
  }

  const recent = turns.slice(Math.max(0, turns.length - maxTurns));
  const kept: AgentHistoryTurn[] = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    if (!turn) continue;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (turn.text.length > remaining) {
      if (kept.length === 0) kept.unshift({ role: turn.role, text: clip(turn.text, remaining) });
      break;
    }
    kept.unshift(turn);
    used += turn.text.length;
  }
  return kept;
}
