import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { presentCatalog } from '../../lib/product-catalog';
import { cacheGet, cacheSet } from '../../lib/response-cache';
import { getMarketPriceIndex } from './market-prices';

export const catalogRouter = Router();

const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Searchable commercial catalog (20 categories + item names / MOQ). */
catalogRouter.get('/catalog/order-items', authenticate, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  // `full=1` returns every category (default view is capped to a preview slice).
  const full = req.query.full === '1' || req.query.full === 'true';
  const cacheKey = `catalog:items:${q ?? ''}:${category ?? ''}:${full ? 'full' : ''}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }
  const base = presentCatalog({
    q,
    category,
    ...(full ? { previewLimit: Number.MAX_SAFE_INTEGER } : {}),
  });
  // Live median of recent winning bids; falls back to the category band in the app.
  const market = await getMarketPriceIndex().catch(() => new Map());
  const payload = {
    ...base,
    categories: base.categories.map((c) => ({
      ...c,
      items: c.items.map((i) => {
        const m = market.get(`${c.slug}:${i.slug}`);
        return m ? { ...i, marketPaise: m.paise, marketSamples: m.samples } : i;
      }),
    })),
  };
  await cacheSet(cacheKey, payload, CATALOG_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});
