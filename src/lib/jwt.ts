import {
  createRemoteJWKSet,
  jwtVerify,
  decodeJwt,
  decodeProtectedHeader,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { config } from '../config';
import { logger } from './logger';

export type SupabaseAccessClaims = JWTPayload & {
  sub: string;
  email?: string;
  phone?: string;
  role?: string;
  app_metadata?: {
    role?: string;
    [key: string]: unknown;
  };
  user_metadata?: {
    full_name?: string;
    name?: string;
    [key: string]: unknown;
  };
};

let secretKey: Uint8Array | null = null;
let jwks: JWTVerifyGetKey | null = null;
let jwksInitFailed = false;
/** Once-per-process dampener for noisy HS256 path. */
let hs256WarnLogged = false;
let jwksOkLogged = false;

function getSecretKey(): Uint8Array | null {
  if (!config.supabaseJwtSecret) return null;
  if (!secretKey) {
    secretKey = new TextEncoder().encode(config.supabaseJwtSecret.trim());
  }
  return secretKey;
}

function expectedIssuers(): string[] {
  if (!config.supabaseUrl) return [];
  const base = config.supabaseUrl.replace(/\/$/, '');
  return [`${base}/auth/v1`, base];
}

function getJwks(): JWTVerifyGetKey | null {
  if (jwksInitFailed || !config.supabaseUrl) return null;
  if (!jwks) {
    try {
      const base = config.supabaseUrl.replace(/\/$/, '');
      jwks = createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`));
    } catch (e) {
      jwksInitFailed = true;
      logger.warn('jwt', 'JWKS init failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
  return jwks;
}

function asClaims(payload: JWTPayload): SupabaseAccessClaims | null {
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  const issuers = expectedIssuers();
  if (payload.iss && issuers.length && !issuers.includes(String(payload.iss))) {
    logger.warn('jwt', 'issuer mismatch', {
      got: payload.iss,
      expected: issuers,
    });
    return null;
  }
  return payload as SupabaseAccessClaims;
}

/**
 * Fast local verify: ES256/RS256 via Supabase JWKS, then legacy HS256 secret.
 * Prefer this over network getUser on every request.
 */
export async function verifySupabaseAccessToken(
  token: string,
): Promise<SupabaseAccessClaims | null> {
  const meta = peekJwtMeta(token);
  const alg = meta.alg ?? '';

  // Asymmetric project keys (current Supabase default)
  if (alg && alg !== 'HS256') {
    const set = getJwks();
    if (set) {
      try {
        const { payload } = await jwtVerify(token, set, {
          algorithms: ['ES256', 'ES384', 'RS256', 'RS384'],
        });
        const claims = asClaims(payload);
        if (claims) {
          if (!jwksOkLogged) {
            jwksOkLogged = true;
            logger.info('jwt', 'JWKS verify OK (hot path)', { alg });
          }
          return claims;
        }
      } catch (e) {
        logger.warn('jwt', 'JWKS verify failed', {
          alg,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Legacy shared-secret projects
  const key = getSecretKey();
  if (!key) return null;

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
    });
    return asClaims(payload);
  } catch (e) {
    if (!hs256WarnLogged) {
      hs256WarnLogged = true;
      logger.warn('jwt', 'local HS256 verify failed (logged once per process)', {
        alg: meta.alg,
        iss: meta.iss,
        error: e instanceof Error ? e.message : String(e),
        hint:
          meta.alg && meta.alg !== 'HS256'
            ? 'Asymmetric JWT — JWKS failed/unavailable; falling back to auth.getUser once per token'
            : 'Check SUPABASE_JWT_SECRET matches Project Settings → API → JWT Secret',
      });
    }
    return null;
  }
}

/** Cheap inspect for debugging without trusting signature. */
export function peekJwtMeta(token: string): { alg?: string; iss?: string; sub?: string } {
  try {
    const header = decodeProtectedHeader(token);
    const payload = decodeJwt(token);
    return {
      alg: header.alg,
      iss: typeof payload.iss === 'string' ? payload.iss : undefined,
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    };
  } catch {
    return {};
  }
}
