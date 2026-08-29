/**
 * L1 process-local TTL + L2 Redis for expensive GET responses.
 * Redis miss / missing REDIS_URL still uses memory so a single instance stays fast.
 */
import { redisDelPrefix, redisGet, redisSet } from './redis';

type Entry = { exp: number; body: unknown };

const store = new Map<string, Entry>();

export function responseCacheGet<T = unknown>(key: string): T | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    store.delete(key);
    return null;
  }
  return hit.body as T;
}

export function responseCacheSet(key: string, body: unknown, ttlMs: number): void {
  store.set(key, { body, exp: Date.now() + ttlMs });
  if (store.size > 200) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
  }
}

export function responseCacheInvalidate(prefix: string): void {
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const mem = responseCacheGet<T>(key);
  if (mem != null) return mem;
  const raw = await redisGet(key);
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as T;
    responseCacheSet(key, body, 2_000);
    return body;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, body: unknown, ttlMs: number): Promise<void> {
  responseCacheSet(key, body, ttlMs);
  const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
  await redisSet(key, JSON.stringify(body), ttlSec);
}

export async function cacheInvalidate(prefix: string): Promise<void> {
  responseCacheInvalidate(prefix);
  await redisDelPrefix(prefix);
}

export async function invalidateBidzoneFeeds() {
  await cacheInvalidate('bidzone:feed:');
}

export async function invalidateConsumerLists(userId: string) {
  await Promise.all([
    cacheInvalidate(`dash:consumer:${userId}`),
    cacheInvalidate(`demand:list:${userId}`),
    cacheInvalidate(`orders:consumer:${userId}`),
  ]);
}

export async function invalidateSupplierLists(userId: string) {
  await Promise.all([
    cacheInvalidate(`bidzone:feed:${userId}`),
    cacheInvalidate(`orders:supplier:${userId}`),
    cacheInvalidate(`supplier:bids:${userId}`),
  ]);
}

export async function invalidateDemandDetail(bidRequestId: string) {
  await Promise.all([
    cacheInvalidate(`demand:detail:${bidRequestId}:`),
    cacheInvalidate(`demand:bids:${bidRequestId}:`),
  ]);
}

export async function invalidateSupplierBids(userId: string) {
  await cacheInvalidate(`supplier:bids:${userId}`);
}

export async function invalidateOrderCaches(orderId: string) {
  await Promise.all([
    cacheInvalidate(`order:detail:${orderId}:`),
    cacheInvalidate(`order:challan:${orderId}:`),
  ]);
}
