import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  ChatRequest,
  ExecutionEvent,
  Problem,
  toJsonSchema,
} from '@coderax/contracts';

/**
 * Zod 4 migration evidence.
 *
 * A successful `tsc -b` does not prove that runtime validation or the generated
 * document still behaves. These checks cover the constructs the contracts use:
 * defaults, optional fields, strict objects, discriminated unions, refinements
 * and the hand-written JSON-Schema bridge.
 */

test('defaults are applied at runtime and omitted from the required list', () => {
  const parsed = ChatRequest.parse({ message: 'hello' });
  assert.equal(parsed.agent, 'coderax');
  assert.equal(parsed.mode, 'private');

  const schema = toJsonSchema(ChatRequest);
  const required = schema.required as string[];
  assert.ok(required.includes('message'));
  assert.ok(!required.includes('conversationId'));
  assert.ok(!required.includes('agent'));
  assert.ok(!required.includes('mode'));
});

test('strict objects reject unknown keys and malformed values', () => {
  assert.equal(ChatRequest.safeParse({ message: 'hello', unexpected: true }).success, false);
  assert.equal(ChatRequest.safeParse({ message: '' }).success, false);
  assert.equal(Problem.safeParse({ code: 'not_a_code' }).success, false);
});

test('optional fields are absent without failing and present when supplied', () => {
  assert.equal(ChatRequest.safeParse({ message: 'hello' }).success, true);
  const withConversation = ChatRequest.safeParse({
    message: 'hello',
    conversationId: 'conv_zod4',
  });
  assert.equal(withConversation.success, true);
  if (withConversation.success) {
    assert.equal(withConversation.data.conversationId, 'conv_zod4');
  }
});

test('the discriminated event union validates the discriminator and payload', () => {
  const valid = ExecutionEvent.safeParse({
    v: 1,
    eventId: 'evt_zod4',
    taskId: 'task_zod4',
    seq: 1,
    at: new Date().toISOString(),
    agent: 'coderax',
    generation: 1,
    type: 'task.queued',
  });
  assert.equal(valid.success, true);

  assert.equal(
    ExecutionEvent.safeParse({
      v: 1,
      eventId: 'evt_zod4',
      taskId: 'task_zod4',
      seq: 1,
      at: new Date().toISOString(),
      agent: 'coderax',
      generation: 1,
      type: 'not.an.event',
    }).success,
    false,
  );

  const schema = toJsonSchema(ExecutionEvent);
  assert.ok(Array.isArray(schema.anyOf));
});

test('refinements still run at runtime and keep their base JSON shape', () => {
  const nonEmpty = z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'must contain a non-space character',
  });
  assert.equal(nonEmpty.safeParse('   ').success, false);
  assert.equal(nonEmpty.safeParse('ok').success, true);
  assert.equal(toJsonSchema(nonEmpty).type, 'string');

  const checkedObject = z
    .object({ count: z.number().int() })
    .refine((value) => value.count > 0, { message: 'count must be positive' });
  assert.equal(checkedObject.safeParse({ count: 0 }).success, false);
  assert.equal(toJsonSchema(checkedObject).type, 'object');
});

test('the generated schema keeps strictness, records and arrays intact', () => {
  const schema = z
    .object({
      records: z.record(z.string(), z.number()),
      values: z.array(z.string()),
      optional: z.boolean().optional(),
    })
    .strict();
  const json = toJsonSchema(schema);
  assert.equal(json.type, 'object');
  assert.equal(json.additionalProperties, false);

  const properties = json.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.records?.type, 'object');
  assert.deepEqual(properties.records?.additionalProperties, { type: 'number' });
  assert.deepEqual(properties.values, { type: 'array', items: { type: 'string' } });
  assert.ok(!((json.required as string[]) ?? []).includes('optional'));
});

test('published enums use runtime values and preserve strings and numbers', () => {
  enum Numeric { Zero, One }
  assert.deepEqual(toJsonSchema(z.enum(Numeric)), { type: 'number', enum: [0, 1] });
  const mixed = z.enum({ Private: 'private', Default: 0 });
  assert.equal(mixed.safeParse('Private').success, false);
  assert.deepEqual(toJsonSchema(mixed), { type: ['string', 'number'], enum: ['private', 0] });
  assert.deepEqual(toJsonSchema(z.enum(['a', 'b'])), { type: 'string', enum: ['a', 'b'] });
});

test('record conversion does not publish broader key constraints', () => {
  const constrained = z.record(z.enum(['a', 'b']), z.number());
  assert.equal(constrained.safeParse({}).success, false);
  assert.throws(() => toJsonSchema(constrained), /unconstrained string record keys/);
  assert.throws(() => toJsonSchema(z.record(z.string().min(1), z.number())), /record keys/);
  assert.deepEqual(toJsonSchema(z.record(z.string(), z.number())), {
    type: 'object',
    additionalProperties: { type: 'number' },
  });
});
