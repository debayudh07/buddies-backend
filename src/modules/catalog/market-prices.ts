import { prisma } from '../../lib/prisma';
import { CATEGORY_PRICE_REF } from '../../lib/product-catalog';

const WINDOW_DAYS = 90;
const MIN_SAMPLES = 3;
const REFRESH_MS = 30 * 60 * 1000;

export type MarketPrice = { paise: number; samples: number };

let cache: { at: number; byItem: Map<string, MarketPrice> } | null = null;

/** Normalise a per-requested-unit price to the category's reference unit. */
function toRefUnit(unitPricePaise: number, unit: string, per: 'kg' | 'L' | 'pcs'): number | null {
  const u = unit.toLowerCase();
  if (per === 'kg') {
    if (u === 'kg') return unitPricePaise;
    if (u === 'g') return unitPricePaise * 1000;
    return null;
  }
  if (per === 'L') {
    if (u === 'l') return unitPricePaise;
    if (u === 'ml') return unitPricePaise * 1000;
    return null;
  }
  return u === 'pcs' || u === 'pc' ? unitPricePaise : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Median winning unit price per catalog item over the last 90 days, keyed
 * `<categorySlug>:<itemSlug>`. Only items with at least 3 samples are returned,
 * and samples far outside the category's indicative band are dropped as noise.
 */
export async function getMarketPriceIndex(): Promise<Map<string, MarketPrice>> {
  if (cache && Date.now() - cache.at < REFRESH_MS) return cache.byItem;

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3_600_000);
  const lines = await prisma.bidLineItem.findMany({
    where: {
      unitPricePaise: { gt: 0 },
      bid: { status: 'accepted', acceptedAt: { gte: since } },
      bidRequestItem: { catalogItemSlug: { not: null }, catalogCategory: { not: null } },
    },
    select: {
      unitPricePaise: true,
      bidRequestItem: { select: { catalogCategory: true, catalogItemSlug: true, unit: true } },
    },
    take: 20_000,
  });

  const samples = new Map<string, number[]>();
  for (const l of lines) {
    const item = l.bidRequestItem;
    const catSlug = item.catalogCategory;
    const itemSlug = item.catalogItemSlug;
    const ref = catSlug ? CATEGORY_PRICE_REF[catSlug] : undefined;
    if (!catSlug || !itemSlug || !ref || l.unitPricePaise == null) continue;
    const norm = toRefUnit(l.unitPricePaise, item.unit, ref.per);
    if (norm == null) continue;
    if (norm < ref.minPaise * 0.3 || norm > ref.maxPaise * 3) continue;
    const key = `${catSlug}:${itemSlug}`;
    const arr = samples.get(key);
    if (arr) arr.push(norm);
    else samples.set(key, [norm]);
  }

  const byItem = new Map<string, MarketPrice>();
  for (const [key, arr] of samples) {
    if (arr.length >= MIN_SAMPLES) byItem.set(key, { paise: median(arr), samples: arr.length });
  }
  cache = { at: Date.now(), byItem };
  return byItem;
}
