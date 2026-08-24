import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { presentCatalog } from '../../lib/product-catalog';

export const catalogRouter = Router();

/** Searchable commercial catalog (20 categories + item names / MOQ). */
catalogRouter.get('/catalog/order-items', authenticate, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  res.json(presentCatalog({ q, category }));
});
