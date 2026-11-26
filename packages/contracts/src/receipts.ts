import { z } from 'zod';
import { ConversationId, IsoDateTime, TaskId } from './primitives.js';

/**
 * Operational evidence for one execution.
 *
 * A receipt records that an action happened and what its outcome was. It never
 * contains message text, a credential or an absolute path, so it can be retained
 * and shown to a client without becoming a second copy of private content.
 */
export const ExecutionReceipt = z
  .object({
    receipt: z.string().min(1).max(120),
    at: IsoDateTime,
    actor: z.string().min(1).max(128),
    action: z.string().min(1).max(120),
    taskId: TaskId.optional(),
    conversationId: ConversationId.optional(),
    outcome: z.enum(['accepted', 'completed', 'failed', 'cancelled', 'refused']),
    detail: z.string().max(1000).optional(),
    requestId: z.string().min(1).max(128).optional(),
    mode: z.enum(['private', 'cloud']).optional(),
  })
  .strict();
export type ExecutionReceipt = z.infer<typeof ExecutionReceipt>;

export const ReceiptListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type ReceiptListQuery = z.infer<typeof ReceiptListQuery>;

export const ReceiptList = z
  .object({
    receipts: z.array(ExecutionReceipt),
    total: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type ReceiptList = z.infer<typeof ReceiptList>;
