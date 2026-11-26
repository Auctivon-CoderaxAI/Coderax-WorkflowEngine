import type { ImageMediaType } from '@coderax/contracts';
import type { MediaRecord, MediaStore } from '../media/store.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable media bytes.
 *
 * A media row is immutable: it is inserted once under a unique id and read by
 * `(mediaId, ownerId)`. The base64 body is capped by configuration below
 * MongoDB's document limit. An authorization predicate is part of every read, so
 * a repository caller cannot accidentally fetch another owner's upload.
 */

const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function ensureMediaIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ mediaId: 1 }, { unique: true, name: 'media_id' });
  await collection.createIndex(
    { ownerId: 1, createdAt: -1 },
    { name: 'media_owner_created' },
  );
}

function toRecord(document: Record<string, unknown>): MediaRecord {
  if (
    typeof document.mediaId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.mediaType !== 'string' ||
    !IMAGE_TYPES.has(document.mediaType) ||
    typeof document.sha256 !== 'string' ||
    typeof document.data !== 'string' ||
    typeof document.createdAt !== 'string' ||
    typeof document.bytes !== 'number' ||
    typeof document.width !== 'number' ||
    typeof document.height !== 'number' ||
    (document.mode !== 'private' && document.mode !== 'cloud')
  ) {
    throw new Error('A stored media row is malformed.');
  }
  return {
    mediaId: document.mediaId,
    ownerId: document.ownerId,
    kind: 'image',
    mediaType: document.mediaType as ImageMediaType,
    bytes: document.bytes,
    sha256: document.sha256,
    width: document.width,
    height: document.height,
    mode: document.mode,
    createdAt: document.createdAt,
    data: document.data,
  };
}

export function createMongoMediaStore(collection: MongoCollectionLike): MediaStore {
  return {
    put: async (record) => {
      try {
        await collection.insertOne({ ...record });
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new Error('media identity collision');
        }
        throw error;
      }
    },
    get: async (ownerId, mediaId) => {
      const document = await collection.findOne({ mediaId, ownerId });
      return document ? toRecord(document) : null;
    },
  };
}
