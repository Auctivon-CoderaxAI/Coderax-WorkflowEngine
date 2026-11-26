import { z } from 'zod';
import { ChatReply } from './tasks.js';

/**
 * One frame of the Chat SSE stream.
 *
 * Chat answers `text/event-stream` when the client asks for it and a JSON body
 * otherwise. The frame shape matches the contract reserved by the intelligence
 * core owner on `feat/intelligence-core` (`ChatFrame`) byte for byte, so the two
 * halves of the system do not grow two descriptions of the same stream. The
 * alias exists only because `ChatFrame` is already exported by that branch; when
 * the branch lands, the alias is deleted and this schema is the authority.
 *
 * `chat.delta` carries assistant text and `chat.completed` carries the same
 * `ChatReply` the JSON response would have returned. An error happens before the
 * stream opens, so it is a normal Problem response, not an error frame.
 */
export const CHAT_STREAM_SCHEMA_VERSION = 1 as const;

export const ChatStreamFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('chat.completed'), reply: ChatReply }).strict(),
]);
export type ChatStreamFrame = z.infer<typeof ChatStreamFrame>;
