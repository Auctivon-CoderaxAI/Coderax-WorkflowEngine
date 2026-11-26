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

function objectSlice(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function parseObject(text: string): { ok: true; value: unknown } | { ok: false } {
  const slice = objectSlice(text);
  if (!slice) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(slice) };
  } catch {
    return { ok: false };
  }
}

export function parseAction(raw: string): ModelAction {
  // The raw object is tried first. A creative deliverable is a fenced SVG or
  // HTML block inside a JSON string; extracting the first fence before parsing
  // would discard the object and reject a perfectly valid action.
  let parsedResult = parseObject(raw);
  if (!parsedResult.ok) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (fenced?.[1]) parsedResult = parseObject(fenced[1]);
  }
  if (!parsedResult.ok) {
    return { kind: 'invalid', reason: 'No JSON object was returned or it could not be parsed.' };
  }
  const parsed: unknown = parsedResult.value;

  const root = objectOf(parsed);
  if (!root) return { kind: 'invalid', reason: 'The returned JSON was not an object.' };
  const action = objectOf(root.action) ?? root;
  const thought = typeof root.thought === 'string' ? root.thought.slice(0, 1000) : '';

  const final = action.final ?? action.answer;
  if (typeof final === 'string') {
    return final.trim() ? { kind: 'final', text: final, thought } : { kind: 'invalid', reason: 'The final answer was empty.' };
  }

  const tool = action.tool ?? action.name;
  if (typeof tool === 'string' && tool.trim().length > 0) {
    const input = objectOf(action.input ?? action.arguments) ?? {};
    return { kind: 'tool', tool: tool.trim().slice(0, 120), input, thought };
  }

  return { kind: 'invalid', reason: 'The object named neither a tool nor a final answer.' };
}
