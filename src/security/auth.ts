import { timingSafeEqual } from 'node:crypto';
import type { AuthSettings } from '../configuration/schema.js';

/**
 * Coderax has exactly one principal: its owner.
 *
 * There are no memberships, tenants-as-customers or service accounts. A token is
 * valid only when it is the configured owner token, and the principal it yields
 * is always `isOwner: true`. Every authorization decision downstream can rely on
 * that; no route has to re-derive ownership from a request body.
 */
export type Principal = {
  ownerId: string;
  isOwner: true;
};

export type AuthService = {
  authenticate: (authorization: string | undefined) => Principal | null;
  ownerId: string;
  /** Present so startup can assert the token exists without logging it. */
  tokenConfigured: boolean;
};

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

export function createOwnerAuth(input: {
  config: AuthSettings;
  env: NodeJS.ProcessEnv;
}): AuthService {
  const token = input.env[input.config.tokenEnv];
  if (typeof token !== 'string' || token.length < input.config.minTokenLength) {
    throw new AuthConfigurationError(
      `${input.config.tokenEnv} must be set to a token of at least ${input.config.minTokenLength} characters`,
    );
  }

  return {
    ownerId: input.config.ownerId,
    tokenConfigured: true,
    authenticate: (authorization) => {
      if (typeof authorization !== 'string') return null;
      const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
      if (!match) return null;
      const presented = match[1];
      if (!presented || !safeEqual(presented, token)) return null;
      return { ownerId: input.config.ownerId, isOwner: true };
    },
  };
}
