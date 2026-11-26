import { createHash, randomUUID } from 'node:crypto';
import type {
  Availability,
  MediaCapabilities,
  MediaDescriptor,
  MediaDownload,
  MediaUploadRequest,
  MediaUploadResult,
} from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { decodeBase64 } from './decode.js';
import { sniffImage } from './sniff.js';
import type { MediaRecord, MediaStore } from './store.js';

/**
 * The multimodal intake boundary.
 *
 * Uploads are owner-only, size- and pixel-bounded, identified by magic bytes and
 * scoped to one data mode. Attachments are resolved by owner and mode at the
 * point of use, so a private upload can never be attached to a cloud run and an
 * identifier from another principal is reported as absent. No bytes are
 * decompressed in this process.
 */

export type MediaLimits = {
  enabled: boolean;
  maxBytes: number;
  maxPixels: number;
  maxAttachments: number;
  creativeMaxBytes: number;
  allowPrivateModeAttachments: boolean;
};

export type ResolvedMedia = {
  descriptor: MediaDescriptor;
  /** A data URL handed to the vision model; never logged. */
  dataUrl: string;
};

export type MediaService = {
  upload: (ownerId: string, request: MediaUploadRequest) => Promise<ServiceResult<MediaUploadResult>>;
  get: (ownerId: string, mediaId: string) => Promise<ServiceResult<MediaDownload>>;
  capabilities: (vision: { available: boolean; detail: string }) => MediaCapabilities;
  resolve: (input: {
    ownerId: string;
    mode: MediaDescriptor['mode'];
    mediaIds: readonly string[];
  }) => Promise<ServiceResult<ResolvedMedia[]>>;
};

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

function reason(available: boolean, detail: string): Availability {
  return {
    available,
    reason: available ? 'ready' : 'not_configured',
    detail,
  };
}

function normalizeDeclared(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'image/jpg' ? 'image/jpeg' : trimmed;
}

export function createMediaService(input: {
  store: MediaStore;
  clock: Clock;
  limits: MediaLimits;
}): MediaService {
  function descriptor(record: MediaRecord): MediaDescriptor {
    return {
      mediaId: record.mediaId,
      kind: record.kind,
      mediaType: record.mediaType,
      bytes: record.bytes,
      sha256: record.sha256,
      width: record.width,
      height: record.height,
      mode: record.mode,
      createdAt: record.createdAt,
    };
  }

  return {
    upload: async (ownerId, request) => {
      if (!input.limits.enabled) {
        return fail('media_unsupported', 'Media input is disabled by configuration.');
      }
      const decoded = decodeBase64(request.data, input.limits.maxBytes);
      if (!decoded.ok) return fail(decoded.code, decoded.detail);

      const sniffed = sniffImage(decoded.bytes, { maxPixels: input.limits.maxPixels });
      if (!sniffed.ok) return fail(sniffed.code, sniffed.detail);

      const declared = normalizeDeclared(request.declaredType);
      if (declared !== null && declared !== sniffed.mediaType) {
        return fail(
          'media_invalid',
          'The declared media type does not match the file header.',
        );
      }

      const record: MediaRecord = {
        mediaId: `media_${randomUUID()}`,
        kind: 'image',
        mediaType: sniffed.mediaType,
        bytes: decoded.bytes.length,
        sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
        width: sniffed.width,
        height: sniffed.height,
        mode: request.mode,
        createdAt: input.clock.iso(),
        ownerId,
        data: decoded.bytes.toString('base64'),
      };
      await input.store.put(record);
      return ok({ media: descriptor(record) });
    },

    get: async (ownerId, mediaId) => {
      const record = await input.store.get(ownerId, mediaId);
      if (!record) return fail('not_found', 'That media does not exist for this owner.');
      return ok({ media: descriptor(record), data: record.data });
    },

    capabilities: (vision) => ({
      inputs: [
        {
          kind: 'image',
          available: input.limits.enabled && vision.available,
          mediaTypes: [...IMAGE_TYPES],
          maxBytes: input.limits.maxBytes,
          maxPixels: input.limits.maxPixels,
          reason: input.limits.enabled
            ? reason(
                vision.available,
                vision.available
                  ? 'Image input is ready.'
                  : vision.detail,
              )
            : reason(false, 'Media input is disabled by configuration.'),
        },
        {
          kind: 'audio',
          available: false,
          mediaTypes: [],
          maxBytes: input.limits.maxBytes,
          maxPixels: input.limits.maxPixels,
          reason: reason(false, 'Audio input is not implemented by this deployment.'),
        },
        {
          kind: 'video',
          available: false,
          mediaTypes: [],
          maxBytes: input.limits.maxBytes,
          maxPixels: input.limits.maxPixels,
          reason: reason(false, 'Video input is not implemented by this deployment.'),
        },
        {
          kind: 'document',
          available: false,
          mediaTypes: [],
          maxBytes: input.limits.maxBytes,
          maxPixels: input.limits.maxPixels,
          reason: reason(false, 'Document input is not implemented by this deployment.'),
        },
      ],
      creative: {
        available: true,
        formats: ['svg', 'html'],
        maxBytes: input.limits.creativeMaxBytes,
        sandbox: 'required',
        scripts: false,
        externalResources: false,
        reason: reason(
          true,
          'Generated SVG and HTML can be validated locally; rendering must be sandboxed.',
        ),
      },
      maxAttachments: input.limits.maxAttachments,
      privateModeAttachments: input.limits.allowPrivateModeAttachments
        ? reason(
            true,
            'Private-mode attachments are explicitly enabled; the verified-free provider still receives them.',
          )
        : reason(
            false,
            'Private-mode attachments are disabled because inference is hosted; use cloud mode or enable media.allowPrivateModeAttachments.',
          ),
    }),

    resolve: async ({ ownerId, mode, mediaIds }) => {
      if (mediaIds.length === 0) return ok([]);
      if (!input.limits.enabled) {
        return fail('media_unsupported', 'Media input is disabled by configuration.');
      }
      if (mode === 'private' && !input.limits.allowPrivateModeAttachments) {
        return fail(
          'forbidden',
          'Private-mode attachments are disabled because the verified-free route is a hosted provider; use cloud mode or enable media.allowPrivateModeAttachments explicitly.',
        );
      }
      if (mediaIds.length > input.limits.maxAttachments) {
        return fail(
          'media_invalid',
          `At most ${input.limits.maxAttachments} attachments may be sent with one request.`,
        );
      }
      const unique = [...new Set(mediaIds)];
      if (unique.length !== mediaIds.length) {
        return fail('media_invalid', 'An attachment is listed more than once.');
      }

      const resolved: ResolvedMedia[] = [];
      for (const mediaId of unique) {
        const record = await input.store.get(ownerId, mediaId);
        if (!record) return fail('not_found', 'That media does not exist for this owner.');
        if (record.mode !== mode) {
          return fail(
            'forbidden',
            'Media captured in another data mode cannot be used for this request.',
          );
        }
        resolved.push({
          descriptor: descriptor(record),
          dataUrl: `data:${record.mediaType};base64,${record.data}`,
        });
      }
      return ok(resolved);
    },
  };
}

