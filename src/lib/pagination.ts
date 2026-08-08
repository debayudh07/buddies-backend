/** Shared list query helpers — caps unbounded findMany responses. */

export function parseLimit(
  raw: unknown,
  { defaultLimit = 50, max = 100 }: { defaultLimit?: number; max?: number } = {},
): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultLimit;
  return Math.min(Math.floor(n), max);
}

export function parseCursor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  return s.length > 0 ? s : undefined;
}
