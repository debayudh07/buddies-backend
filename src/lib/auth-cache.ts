/**
 * Short-lived in-process cache for AuthUser identity.
 * Optional Redis when available. Cuts a Prisma round-trip from every request.
 */
import { redisGet, redisSet } from './redis';
import type { AuthUser } from '../middleware/auth';

const memory = new Map<string, { user: AuthUser; exp: number }>();
const TTL_MS = 60_000; // 60s local
const REDIS_TTL_SEC = 90;

function memGet(key: string): AuthUser | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    memory.delete(key);
    return null;
  }
  return hit.user;
}

function memSet(key: string, user: AuthUser) {
  memory.set(key, { user, exp: Date.now() + TTL_MS });
  // Bound map size (dev / multi-user)
  if (memory.size > 5000) {
    const first = memory.keys().next().value;
    if (first) memory.delete(first);
  }
}

export async function getCachedAuthUser(key: string): Promise<AuthUser | null> {
  const local = memGet(key);
  if (local) return local;
  try {
    const raw = await redisGet(`auth:u:${key}`);
    if (raw) {
      const user = JSON.parse(raw) as AuthUser;
      memSet(key, user);
      return user;
    }
  } catch {
    // ignore redis
  }
  return null;
}

export async function setCachedAuthUser(key: string, user: AuthUser): Promise<void> {
  memSet(key, user);
  // Fire-and-forget Redis — do not add write latency on request path.
  void redisSet(`auth:u:${key}`, JSON.stringify(user), REDIS_TTL_SEC).catch(() => undefined);
}

export function invalidateCachedAuthUser(key: string): void {
  memory.delete(key);
  // Best-effort Redis drop (overwrite with short TTL so next read misses quickly).
  void redisSet(`auth:u:${key}`, '', 1).catch(() => undefined);
}
