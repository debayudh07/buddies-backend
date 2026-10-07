import { prisma } from './prisma';
import { PRODUCT_CATEGORIES, getCategoryDef, normalizeProductCategory } from './product-categories';
import { logger } from './logger';

/**
 * Makes sure every product category has a return-window row. Rows that already
 * exist are left alone so admin edits survive; only missing ones are created.
 * Without this, a database that was never seeded rejects every return claim
 * with UNKNOWN_CATEGORY.
 */
export async function ensureReturnWindows(): Promise<void> {
  let created = 0;
  for (const row of PRODUCT_CATEGORIES) {
    const exists = await prisma.returnWindowMatrix.findUnique({
      where: { productCategory: row.productCategory },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.returnWindowMatrix.create({
      data: {
        productCategory: row.productCategory,
        windowHours: row.windowHours,
        validReasons: row.validReasons,
        exampleItems: row.exampleItems,
      },
    });
    created++;
  }
  if (created > 0) logger.info('boot', `seeded ${created} missing return windows`);
}

export type ResolvedReturnWindow = {
  productCategory: string;
  windowHours: number;
  validReasons: string[];
};

/**
 * Resolves the return window for a category slug (aliases and stray whitespace
 * allowed). Prefers the DB row; falls back to the built-in definition so a
 * missing row never blocks a customer.
 */
export async function resolveReturnWindow(raw: string): Promise<ResolvedReturnWindow | null> {
  const slug = normalizeProductCategory(raw);
  const candidates = [...new Set([slug, raw.trim()].filter((s): s is string => !!s))];
  for (const productCategory of candidates) {
    const row = await prisma.returnWindowMatrix.findUnique({ where: { productCategory } });
    if (row) {
      return {
        productCategory: row.productCategory,
        windowHours: row.windowHours,
        validReasons: row.validReasons,
      };
    }
  }
  const def = getCategoryDef(raw);
  if (!def) return null;
  return {
    productCategory: def.productCategory,
    windowHours: def.windowHours,
    validReasons: def.validReasons,
  };
}
