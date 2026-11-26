import { CoderaxContractError } from './errors.js';

export type ParsedSseFrame = {
  /** The SSE `id:` cursor, which corresponds to the per-task event sequence. */
  id?: string;
  data: unknown;
};

/**
 * Parses an SSE body into frames.
 *
 * Both stream families use `data:` JSON; execution events additionally carry an
 * `id:` cursor so `Last-Event-ID` can resume them. A frame with no data line is
 * a heartbeat and is skipped. Malformed JSON fails the stream instead of being
 * passed to a renderer.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let id: string | undefined;
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) {
          const candidate = line.slice(3).trim();
          if (candidate.length > 0) id = candidate;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        try {
          yield { ...(id === undefined ? {} : { id }), data: JSON.parse(data) };
        } catch {
          throw new CoderaxContractError('an event frame was not valid JSON');
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export function parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  return (async function* frames() {
    for await (const frame of parseSseFrames(body)) {
      yield frame.data;
    }
  })();
}
