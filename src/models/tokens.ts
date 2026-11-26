/**
 * Token accounting happens before a request is sent, because a budget that is
 * checked afterwards has already been spent.
 *
 * A provider's exact tokenizer is not available to the engine, so the estimate
 * is deliberately conservative: it over-counts rather than under-counts, and it
 * is replaced by the provider's reported usage once the call returns. Tool
 * schemas are counted separately because they are the largest fixed part of a
 * Native prompt and the easiest part to forget.
 */

export type ToolSchemaLike = {
  name: string;
  description?: string;
  parameters?: unknown;
  schema?: unknown;
};

/** Roughly four characters per token, rounded up, never below one. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function serializeSchema(tool: ToolSchemaLike): string {
  try {
    return JSON.stringify({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? tool.schema ?? null,
    });
  } catch {
    return tool.name;
  }
}

/**
 * The serialized tool catalogue is part of the prompt, so it is part of the
 * input the provider bills. A caller passes the same text it embedded.
 */
export function countToolSchemaTokens(schemaText: string): number {
  return estimateTokens(schemaText);
}

export function countToolSchemas(tools: readonly ToolSchemaLike[]): number {
  return estimateTokens(tools.map(serializeSchema).join('\n'));
}

export type RequestTokenEstimate = {
  system: number;
  prompt: number;
  toolSchemas: number;
  total: number;
};

/**
 * Input accounting for one model call. `toolSchemaText` is the exact catalogue
 * text included in the prompt; passing it separately does not double count,
 * because the caller embeds it in `prompt` and this function only reports the
 * split it was told about.
 */
export function estimateRequestTokens(input: {
  system: string;
  prompt: string;
  toolSchemaText?: string;
}): RequestTokenEstimate {
  const system = estimateTokens(input.system);
  const prompt = estimateTokens(input.prompt);
  const toolSchemas = countToolSchemaTokens(input.toolSchemaText ?? '');
  return { system, prompt, toolSchemas, total: system + prompt + toolSchemas };
}

/**
 * Normalizes a provider usage report. A provider that omits usage still gets an
 * estimate recorded, so an unaccounted call can never look free in the ledger.
 */
export function accountUsage(input: {
  reported?: { inputTokens?: number; outputTokens?: number } | undefined;
  estimatedInputTokens: number;
  outputText: string;
}): { inputTokens: number; outputTokens: number } {
  const reportedInput = input.reported?.inputTokens;
  const reportedOutput = input.reported?.outputTokens;
  const inputTokens =
    typeof reportedInput === 'number' && Number.isFinite(reportedInput) && reportedInput >= 0
      ? Math.round(reportedInput)
      : input.estimatedInputTokens;
  const outputTokens =
    typeof reportedOutput === 'number' && Number.isFinite(reportedOutput) && reportedOutput >= 0
      ? Math.round(reportedOutput)
      : estimateTokens(input.outputText);
  return { inputTokens, outputTokens };
}

/**
 * Accumulates usage frames from a streamed completion. Providers that emit
 * `include_usage` send one final frame with totals; some send cumulative usage
 * on every chunk. Taking the maximum per field is correct for both and never
 * under-counts a duplicate frame.
 */
export function foldStreamUsage(
  total: { inputTokens: number; outputTokens: number },
  frame: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined,
): { inputTokens: number; outputTokens: number } {
  const input =
    typeof frame?.prompt_tokens === 'number' && Number.isFinite(frame.prompt_tokens)
      ? frame.prompt_tokens
      : 0;
  const output =
    typeof frame?.completion_tokens === 'number' && Number.isFinite(frame.completion_tokens)
      ? frame.completion_tokens
      : 0;
  return {
    inputTokens: Math.max(total.inputTokens, Math.max(0, Math.round(input))),
    outputTokens: Math.max(total.outputTokens, Math.max(0, Math.round(output))),
  };
}
