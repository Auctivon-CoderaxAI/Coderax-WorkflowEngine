import { z } from 'zod';
import {
  BROWSER_PROTOCOL_VERSION,
  BrowserFeatures,
  BrowserTab,
} from '@coderax/contracts';

/**
 * Versioned browser provider protocol (v1).
 *
 * This is the integration contract an authorized zero-cost provider implements.
 * It describes a remote browser; it is not itself a provider, and no deployment
 * in this repository speaks it until one is configured and verified.
 */

const MAX_BASE64 = 8_000_000;

export const ProviderCapabilitiesResponse = z
  .object({
    protocolVersion: z.literal(BROWSER_PROTOCOL_VERSION),
    provider: z.string().min(1).max(120),
    costClass: z.enum(['free', 'paid']),
    features: BrowserFeatures,
    limits: z
      .object({ maxSessionTtlSeconds: z.number().int().positive() })
      .strict(),
  })
  .strict();
export type ProviderCapabilitiesResponse = z.infer<typeof ProviderCapabilitiesResponse>;

export const ProviderSessionResponse = z
  .object({
    providerSessionId: z.string().min(1).max(200),
    url: z.string().max(2048),
    title: z.string().max(300),
    tabs: z.array(BrowserTab).max(20),
  })
  .strict();
export type ProviderSessionResponse = z.infer<typeof ProviderSessionResponse>;

const ProviderElementResponse = z
  .object({
    elementId: z.string().min(1).max(200),
    role: z.string().min(1).max(64),
    name: z.string().max(1000),
    value: z.string().max(2000).optional(),
    inputType: z.string().max(64).optional(),
    disabled: z.boolean().optional(),
    focused: z.boolean().optional(),
  })
  .strict();

export const ProviderActionResponse = z
  .object({
    url: z.string().max(2048),
    title: z.string().max(1000),
    tabs: z.array(BrowserTab).max(20).optional(),
    observation: z
      .object({
        text: z.string().max(50_000).optional(),
        elements: z.array(ProviderElementResponse).max(1000).optional(),
        truncated: z.boolean().optional(),
      })
      .strict()
      .optional(),
    artifacts: z
      .array(
        z
          .object({
            kind: z.enum(['screenshot', 'download', 'upload']),
            contentType: z.string().min(3).max(120),
            dataBase64: z.string().min(4).max(MAX_BASE64),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export type ProviderActionResponse = z.infer<typeof ProviderActionResponse>;

export const ProviderTakeoverResponse = z
  .object({ interactiveUrl: z.string().min(8).max(4096) })
  .strict();

export const ProviderOkResponse = z.object({ ok: z.literal(true) }).strict();
