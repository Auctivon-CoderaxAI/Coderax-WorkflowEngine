import type { MediaDescriptor } from '@coderax/contracts';

/**
 * Media bytes live behind one owner-scoped port so the in-memory and MongoDB
 * deployments cannot diverge in authorization behavior. A lookup always names
 * the owner: there is no "get by id" that would let a route or an agent reach
 * another principal's upload.
 */
export type MediaRecord = MediaDescriptor & {
  ownerId: string;
  /** Canonical base64 of the stored bytes, without a data-URL prefix. */
  data: string;
};

export type MediaStore = {
  put: (record: MediaRecord) => Promise<void>;
  get: (ownerId: string, mediaId: string) => Promise<MediaRecord | null>;
};

export function createMediaStore(): MediaStore {
  const records = new Map<string, MediaRecord>();

  return {
    put: async (record) => {
      if (records.has(record.mediaId)) {
        throw new Error('media identity collision');
      }
      records.set(record.mediaId, { ...record });
    },
    get: async (ownerId, mediaId) => {
      const record = records.get(mediaId);
      if (!record || record.ownerId !== ownerId) return null;
      return { ...record };
    },
  };
}
