import { createHash } from 'node:crypto';
import type {
  Availability,
  DataMode,
  MediaCapabilities,
  MediaDescriptor,
  MediaDownload,
  MediaUploadRequest,
  MediaUploadResult,
} from '@coderax/contracts';
import type { ArtifactService } from '../artifacts/service.js';
import type { Clock } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { decodeBase64 } from './decode.js';
import { sniffImage } from './sniff.js';

/**
 * The multimodal intake boundary.
 *
 * Uploads are owner-only, size- and pixel-bounded, identified by magic bytes and
 * scoped to one data mode. Attachments are resolved by owner and mode at the
 * point of use, so a private upload can never be attached to a cloud run and an
 * identifier from another principal is reported as absent. No bytes are
 * decompressed in this process.
 *
 * Media has no storage of its own: an image is an immutable artifact version in
 * the durable artifact store. The media id is the artifact id, and the artifact
 * descriptor is the single authoritative record for its bytes and retention.
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
    mode: DataMode;
    mediaIds: readonly string[];
  }) => Promise<ServiceResult<ResolvedMedia[]>>;
};

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const EXTENSIONS: Readonly<Record<(typeof IMAGE_TYPES)[number], string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

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
  artifacts: ArtifactService;
  clock: Clock;
  limits: MediaLimits;
}): MediaService {
  type StoredMedia = {
    descriptor: MediaDescriptor;
    data: string;
  };

  function principal(ownerId: string) {
    return { ownerId, isOwner: true } as const;
  }

  async function read(
    ownerId: string,
    mediaId: string,
    mode: DataMode,
  ): Promise<ServiceResult<StoredMedia>> {
    const downloaded = await input.artifacts.download(principal(ownerId), mediaId, { mode });
    if (!downloaded.ok) return downloaded;
    const bytes = Buffer.from(downloaded.value.contentBase64, 'base64');
    const sniffed = sniffImage(bytes, { maxPixels: input.limits.maxPixels });
    if (!sniffed.ok) return fail(sniffed.code, sniffed.detail);
    return ok({
      descriptor: {
        mediaId: downloaded.value.artifact.artifactId,
        kind: 'image',
        mediaType: downloaded.value.artifact.mediaType as MediaDescriptor['mediaType'],
        bytes: downloaded.value.artifact.bytes,
        sha256: downloaded.value.artifact.sha256,
        width: sniffed.width,
        height: sniffed.height,
        mode: downloaded.value.artifact.mode,
        createdAt: downloaded.value.artifact.createdAt,
      },
      data: downloaded.value.contentBase64,
    });
  }

  async function resolveOne(
    ownerId: string,
    mode: DataMode,
    mediaId: string,
  ): Promise<ServiceResult<StoredMedia>> {
    const requested = await read(ownerId, mediaId, mode);
    if (requested.ok) return requested;
    const otherMode: DataMode = mode === 'private' ? 'cloud' : 'private';
    const other = await read(ownerId, mediaId, otherMode);
    if (other.ok) {
      return fail(
        'forbidden',
        'Media captured in another data mode cannot be used for this request.',
      );
    }
    return requested;
  }

  function descriptor(stored: StoredMedia): MediaDescriptor {
    return stored.descriptor;
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

      const uploaded = await input.artifacts.upload(principal(ownerId), {
        filename: `media.${EXTENSIONS[sniffed.mediaType as keyof typeof EXTENSIONS]}`,
        mediaType: sniffed.mediaType,
        contentBase64: decoded.bytes.toString('base64'),
        sha256: createHash('sha256').update(decoded.bytes).digest('hex'),
        kind: 'image',
        mode: request.mode,
        note: 'Multimodal image attachment.',
      });
      if (!uploaded.ok) return uploaded;

      const descriptor: MediaDescriptor = {
        mediaId: uploaded.value.artifact.artifactId,
        kind: 'image',
        mediaType: uploaded.value.artifact.mediaType as MediaDescriptor['mediaType'],
        bytes: uploaded.value.artifact.bytes,
        sha256: uploaded.value.artifact.sha256,
        width: sniffed.width,
        height: sniffed.height,
        mode: uploaded.value.artifact.mode,
        createdAt: uploaded.value.artifact.createdAt,
      };
      return ok({ media: descriptor });
    },

    get: async (ownerId, mediaId) => {
      const privateRead = await read(ownerId, mediaId, 'private');
      if (privateRead.ok) {
        return ok({ media: descriptor(privateRead.value), data: privateRead.value.data });
      }
      const cloudRead = await read(ownerId, mediaId, 'cloud');
      if (!cloudRead.ok) {
        return fail('not_found', 'That media does not exist for this owner.');
      }
      return ok({ media: descriptor(cloudRead.value), data: cloudRead.value.data });
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
        const stored = await resolveOne(ownerId, mode, mediaId);
        if (!stored.ok) return stored;
        resolved.push({
          descriptor: descriptor(stored.value),
          dataUrl: `data:${stored.value.descriptor.mediaType};base64,${stored.value.data}`,
        });
      }
      return ok(resolved);
    },
  };
}
