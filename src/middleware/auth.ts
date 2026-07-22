import { Request, Response, NextFunction } from 'express';
import { UserRole } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { getSupabaseAdmin } from '../lib/supabase';
import { AppError } from '../lib/errors';

export type AuthUser = {
  id: string;
  role: UserRole;
  supabaseId?: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

async function resolveDevAuth(header: string): Promise<AuthUser | null> {
  // Bearer dev:consumer:<uuid> or Bearer dev:supplier:<uuid>
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token.startsWith('dev:')) return null;
  const parts = token.split(':');
  if (parts.length < 3) return null;
  const role = parts[1] as UserRole;
  const userId = parts.slice(2).join(':');
  if (!['consumer', 'supplier', 'admin'].includes(role)) return null;

  let user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        id: userId,
        role,
        displayName: `Dev ${role}`,
        phone: '+910000000000',
      },
    });
  }
  return { id: user.id, role: user.role, supabaseId: user.supabaseId };
}

async function resolveSupabaseAuth(header: string): Promise<AuthUser | null> {
  const token = header.replace(/^Bearer\s+/i, '');
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;

  const supabaseId = data.user.id;
  let user = await prisma.user.findUnique({ where: { supabaseId } });
  if (!user) {
    const metaRole = (data.user.app_metadata?.role as UserRole) || 'consumer';
    user = await prisma.user.create({
      data: {
        supabaseId,
        role: metaRole,
        phone: data.user.phone ?? undefined,
        email: data.user.email ?? undefined,
        displayName: data.user.user_metadata?.full_name ?? undefined,
      },
    });
  }
  return { id: user.id, role: user.role, supabaseId: user.supabaseId };
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header) return next(new AppError(401, 'UNAUTHORIZED', 'Missing Authorization header'));

  try {
    let auth: AuthUser | null = null;
    if (config.devAuthBypass && header.includes('dev:')) {
      auth = await resolveDevAuth(header);
    }
    if (!auth) {
      auth = await resolveSupabaseAuth(header);
    }
    if (!auth && config.devAuthBypass) {
      // last resort parse
      auth = await resolveDevAuth(header);
    }
    if (!auth) return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token'));
    req.user = auth;
    next();
  } catch (e) {
    next(e);
  }
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
