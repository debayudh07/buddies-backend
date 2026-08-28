import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { presentCatalog } from '../../lib/product-catalog';
import { cacheGet, cacheSet } from '../../lib/response-cache';

export const catalogRouter = Router();

const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Searchable commercial catalog (20 categories + item names / MOQ). */
catalogRouter.get('/catalog/order-items', authenticate, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const cacheKey = `catalog:items:${q ?? ''}:${category ?? ''}`;
  const cached = await cacheGet<unknown>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cached);
    return;
  }
  const payload = presentCatalog({ q, category });
  await cacheSet(cacheKey, payload, CATALOG_TTL_MS);
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});
