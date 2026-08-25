import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { peekJwtMeta, verifySupabaseAccessToken } from '../lib/jwt';
import { AppError } from '../lib/errors';
import {
  getCachedAuthUser,
  setCachedAuthUser,
} from '../lib/auth-cache';
import { logger } from '../lib/logger';

export type AuthUser = {
  id: string;
  role: UserRole;
  supabaseId?: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Milliseconds spent in authenticate() (token verify + cache). */
      authMs?: number;
    }
  }
}

/** Stable short key for a bearer token → skip getUser/Prisma when warm. */
function tokenAuthCacheKey(token: string): string {
  const h = createHash('sha256').update(token).digest('hex').slice(0, 40);
  return `tok:${h}`;
}

async function resolveDevAuth(header: string): Promise<AuthUser | null> {
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token.startsWith('dev:')) return null;
  const parts = token.split(':');
  if (parts.length < 3) return null;
  const role = parts[1] as UserRole;
  const userId = parts.slice(2).join(':');
  if (!['consumer', 'supplier', 'admin'].includes(role)) return null;

  const cacheKey = `dev:${userId}`;
  const cached = await getCachedAuthUser(cacheKey);
  if (cached) return cached;

  let user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, supabaseId: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        id: userId,
        role,
        displayName: null,
        phone: '+910000000000',
      },
      select: { id: true, role: true, supabaseId: true },
    });
  }
  const auth: AuthUser = { id: user.id, role: user.role, supabaseId: user.supabaseId };
  await setCachedAuthUser(cacheKey, auth);
  return auth;
}

/**
 * Resolve Supabase session with a fast hot path:
 * 1) Per-token memory cache (no network)
 * 2) Local JWT verify (JWKS ES256 / HS256 secret)
 * 3) One getUser network call on miss, then cache
 * Target: repeated reads under ~200ms when cache/JWKS hit.
 */
async function resolveSupabaseAuth(header: string): Promise<AuthUser | null> {
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token.startsWith('dev:')) return null;

  const tokKey = tokenAuthCacheKey(token);
  const warm = await getCachedAuthUser(tokKey);
  if (warm) return warm;

  let claims = await verifySupabaseAccessToken(token);

  // Rare cold path: network getUser (asymmetric without JWKS, expired clock skew, etc.)
  if (!claims?.sub) {
    const meta = peekJwtMeta(token);
    const { getSupabaseAdmin } = await import('../lib/supabase');
    const sb = getSupabaseAdmin();
    if (!sb) {
      logger.warn('auth', 'no admin client for getUser fallback', meta);
      return null;
    }
    const { data, error } = await sb.auth.getUser(token);
    if (error || !data.user) {
      logger.warn('auth', 'getUser fallback failed', {
        ...meta,
        error: error?.message ?? 'no user',
      });
      return null;
    }
    claims = {
      sub: data.user.id,
      email: data.user.email,
      phone: data.user.phone,
      app_metadata: data.user.app_metadata as Record<string, unknown>,
      user_metadata: data.user.user_metadata as Record<string, unknown>,
    };
  }

  if (!claims?.sub) return null;

  const supabaseId = claims.sub;
  const cachedBySub = await getCachedAuthUser(supabaseId);
  if (cachedBySub) {
    // Token may be new after refresh — also bind this bearer to warm auth.
    await setCachedAuthUser(tokKey, cachedBySub);
    return cachedBySub;
  }

  const metaRole =
    (claims.app_metadata?.role as UserRole | undefined) || 'consumer';

  let user = await prisma.user.findUnique({
    where: { supabaseId },
    select: { id: true, role: true, supabaseId: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        supabaseId,
        role: ['consumer', 'supplier', 'admin'].includes(metaRole)
          ? metaRole
          : 'consumer',
        phone: claims.phone ?? undefined,
        email: claims.email ?? undefined,
        displayName:
          (claims.user_metadata?.full_name as string | undefined) ??
          (claims.user_metadata?.name as string | undefined) ??
          undefined,
      },
      select: { id: true, role: true, supabaseId: true },
    });
  } else {
    void syncContactFields(user.id, claims).catch(() => undefined);
  }

  const auth: AuthUser = {
    id: user.id,
    role: user.role,
    supabaseId: user.supabaseId,
  };
  await setCachedAuthUser(supabaseId, auth);
  await setCachedAuthUser(tokKey, auth);
  return auth;
}

async function syncContactFields(
  userId: string,
  claims: {
    email?: string;
    phone?: string;
    user_metadata?: { full_name?: string; name?: string; [k: string]: unknown };
  },
) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true, displayName: true },
  });
  if (!existing) return;
  const nextEmail = claims.email ?? null;
  const nextPhone = claims.phone ?? null;
  const metaName =
    (claims.user_metadata?.full_name as string | undefined) ??
    (claims.user_metadata?.name as string | undefined);
  const data: { email?: string | null; phone?: string | null; displayName?: string } =
    {};
  if (nextEmail && nextEmail !== existing.email) data.email = nextEmail;
  if (nextPhone && nextPhone !== existing.phone) data.phone = nextPhone;
  if (!existing.displayName && metaName) data.displayName = metaName;
  if (Object.keys(data).length > 0) {
    await prisma.user.update({ where: { id: userId }, data });
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header) return next(new AppError(401, 'UNAUTHORIZED', 'Missing Authorization header'));

  const authStarted = Date.now();
  try {
    let auth: AuthUser | null = null;
    if (config.devAuthBypass && header.includes('dev:')) {
      auth = await resolveDevAuth(header);
    }
    if (!auth) {
      auth = await resolveSupabaseAuth(header);
    }
    if (!auth && config.devAuthBypass) {
      auth = await resolveDevAuth(header);
    }
    req.authMs = Date.now() - authStarted;
    if (!auth) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token'));
    req.user = auth;
    next();
  } catch (e) {
    req.authMs = Date.now() - authStarted;
    next(e);
  }
}

export async function resolveAuthFromHeader(header: string): Promise<AuthUser | null> {
  let auth: AuthUser | null = null;
  if (config.devAuthBypass && header.includes('dev:')) {
    auth = await resolveDevAuth(header);
  }
  if (!auth) {
    auth = await resolveSupabaseAuth(header);
  }
  if (!auth && config.devAuthBypass) {
    auth = await resolveDevAuth(header);
  }
  return auth;
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, 'UNAUTHORIZED', 'Not authenticated'));
    if (!roles.includes(req.user.role) && req.user.role !== 'admin') {
      return next(new AppError(403, 'FORBIDDEN', `Requires role: ${roles.join('|')}`));
    }
    next();
  };
}
