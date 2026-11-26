/**
 * The action protocol is a JSON object in the model's text. It is intentionally
 * provider-independent: it works with any chat-completions model, including one
 * that has no native function-calling support, and the engine validates every
 * field before dispatch.
 */
export type ModelAction =
  | { kind: 'tool'; tool: string; input: Record<string, unknown>; thought: string }
  | { kind: 'final'; text: string; thought: string }
  | { kind: 'invalid'; reason: string };

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAction(raw: string): ModelAction {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { kind: 'invalid', reason: 'No JSON object was returned.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return { kind: 'invalid', reason: 'The returned JSON could not be parsed.' };
  }

  const root = objectOf(parsed);
  if (!root) return { kind: 'invalid', reason: 'The returned JSON was not an object.' };
  const action = objectOf(root.action) ?? root;
  const thought = typeof root.thought === 'string' ? root.thought.slice(0, 1000) : '';

  const final = action.final ?? action.answer;
  if (typeof final === 'string') {
    return { kind: 'final', text: final, thought };
  }

  const tool = action.tool ?? action.name;
  if (typeof tool === 'string' && tool.trim().length > 0) {
    const input = objectOf(action.input ?? action.arguments) ?? {};
    return { kind: 'tool', tool: tool.trim().slice(0, 120), input, thought };
  }

  return { kind: 'invalid', reason: 'The object named neither a tool nor a final answer.' };
}
