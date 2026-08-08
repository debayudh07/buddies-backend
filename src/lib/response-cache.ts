/**
 * Tiny process-local TTL cache for expensive GET responses.
 * Cuts repeat Tokyo Prisma trips when the app reopens the same view quickly.
 */
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
