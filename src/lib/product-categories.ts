/**
 * Product category cart + shelf-life / return windows from "The buddies.docx".
 * Slugs are stored on BidRequestItem.productCategory and matrix tables.
 */

export type ProductCategoryDef = {
  /** Stable API slug */
  productCategory: string;
  /** UI label */
  label: string;
  /** Example items (doc sub-category) */
  exampleItems: string;
  /** Typical total shelf life (days) used as supplier default */
  totalShelfLifeDays: number;
  /** Minimum remaining shelf life at delivery (RSL days) */
  minRslDays: number;
  /** Post-delivery hidden-defect return window (hours) */
  windowHours: number;
  /** Example valid return reasons */
  validReasons: string[];
  notes?: string;
};

/** Full categorical cart — one row per selectable product category. */
export const PRODUCT_CATEGORIES: ProductCategoryDef[] = [
  {
    productCategory: 'ultra_fresh_dairy',
    label: 'Ultra-Fresh Dairy',
    exampleItems: 'Fresh pouch milk, curd, paneer',
    totalShelfLifeDays: 5,
    minRslDays: 2,
    windowHours: 1,
    validReasons: ['cold_chain_break', 'leakage', 'low_rsl', 'expired'],
    notes: 'Doc: total 2–5 days; at least 2 full days remaining (excl. delivery day)',
  },
  {
    productCategory: 'ultra_fresh_bakery',
    label: 'Ultra-Fresh Bakery',
    exampleItems: 'Fresh bread, buns, croissants',
    totalShelfLifeDays: 5,
    minRslDays: 3,
    windowHours: 1,
    validReasons: ['cold_chain_break', 'leakage', 'low_rsl', 'mold', 'expired'],
    notes: 'Doc: total 3–5 days; at least 3 days remaining',
  },
  {
    productCategory: 'fresh_proteins',
    label: 'Chilled & Fresh Proteins',
    exampleItems: 'Fresh chicken, fish, buff meat, prawns',
    totalShelfLifeDays: 3,
    minRslDays: 1,
    windowHours: 1,
    validReasons: ['discoloration', 'off_odor', 'temp_abuse', 'wrong_item'],
    notes: 'Doc: total 2–3 days; deliver within 12h of slaughter/harvest preferred',
  },
  {
    productCategory: 'fresh_produce',
    label: 'Fresh Produce',
    exampleItems: 'Leafy greens, tomatoes, exotic veggies',
    totalShelfLifeDays: 5,
    minRslDays: 2,
    windowHours: 2,
    validReasons: ['rotting', 'bruising', 'wrong_weight', 'visual_infestation', 'wrong_item'],
    notes: 'Doc return window 2h; typical short shelf 3–5 days',
  },
  {
    productCategory: 'chilled_cheese',
    label: 'Chilled Cheese',
    exampleItems: 'Mozzarella, cheddar blocks',
    totalShelfLifeDays: 270,
    minRslDays: 60,
    windowHours: 4,
    validReasons: ['thawed', 'bloating', 'broken_seal', 'expired', 'low_rsl'],
    notes: 'Doc: total 6–9 months; minimum 60 days remaining',
  },
  {
    productCategory: 'chilled_fats',
    label: 'Butter, Margarine & Cream',
    exampleItems: 'Butter, cooking margarine, whipping cream',
    totalShelfLifeDays: 365,
    minRslDays: 90,
    windowHours: 4,
    validReasons: ['thawed', 'bloating', 'broken_seal', 'expired', 'low_rsl'],
    notes: 'Doc: total 6–12 months; minimum 90 days remaining',
  },
  {
    productCategory: 'frozen_food',
    label: 'Frozen Food Supply',
    exampleItems: 'Frozen fries, veg patties, frozen purees',
    totalShelfLifeDays: 540,
    minRslDays: 120,
    windowHours: 4,
    validReasons: ['thawed', 'bloating', 'broken_seal', 'expired'],
    notes: 'Doc: total 12–18 months; minimum 120 days remaining',
  },
  {
    productCategory: 'coffee_roasted',
    label: 'Roasted Coffee',
    exampleItems: 'Roasted coffee beans (whole/ground)',
    totalShelfLifeDays: 365,
    minRslDays: 90,
    windowHours: 24,
    validReasons: ['torn_pack', 'stale', 'low_rsl', 'wrong_item'],
    notes: 'Doc: total 6–12 months; min 90 days; roast date <30 days preferred',
  },
  {
    productCategory: 'syrups_crushes',
    label: 'Syrups & Fruit Crushes',
    exampleItems: 'Flavored syrups, fruit crushes, purees',
    totalShelfLifeDays: 1080,
    minRslDays: 180,
    windowHours: 24,
    validReasons: ['cap_damage', 'crystallization', 'low_rsl', 'leakage'],
    notes: 'Doc: total 12–36 months; minimum 6 months (180d) remaining',
  },
  {
    productCategory: 'sauces_condiments',
    label: 'Sauces & Condiments',
    exampleItems: 'Mayonnaise, sauces, dressings, spreads',
    totalShelfLifeDays: 365,
    minRslDays: 60,
    windowHours: 24,
    validReasons: ['cap_damage', 'broken_seal', 'low_rsl', 'leakage', 'wrong_item'],
    notes: 'Doc: total 6–12 months; minimum 60 days remaining',
  },
  {
    productCategory: 'cooking_oils',
    label: 'Cooking Oils',
    exampleItems: 'Mustard, sunflower, rice bran oil',
    totalShelfLifeDays: 365,
    minRslDays: 90,
    windowHours: 24,
    validReasons: ['cap_damage', 'leakage', 'low_rsl', 'wrong_item'],
    notes: 'Doc: total 12 months; minimum 90 days remaining',
  },
  {
    productCategory: 'dry_staples',
    label: 'Dry Kitchen Staples',
    exampleItems: 'Flour (maida), sugar, rice, dry spices',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: ['moisture', 'torn_pack', 'pest', 'wrong_item'],
    notes: 'Doc: total 12–24 months; minimum 180 days remaining',
  },
  {
    productCategory: 'packaged_beverages',
    label: 'Packaged Beverages',
    exampleItems: 'Canned/bottled soda, juices, tonic water',
    totalShelfLifeDays: 180,
    minRslDays: 45,
    windowHours: 24,
    validReasons: ['cap_damage', 'leakage', 'low_rsl', 'bloating', 'expired'],
    notes: 'Doc: total 6 months; minimum 45 days remaining',
  },
];

/** Older seed/app labels → current cart slug. */
const CATEGORY_ALIASES: Record<string, string> = {
  ultra_perishables_dairy: 'ultra_fresh_dairy',
  ultra_fresh_perishables: 'ultra_fresh_dairy',
  dairy: 'ultra_fresh_dairy',
  bakery: 'ultra_fresh_bakery',
  bread: 'ultra_fresh_bakery',
  proteins: 'fresh_proteins',
  meat: 'fresh_proteins',
  produce: 'fresh_produce',
  chilled_frozen_fmcg: 'frozen_food',
  frozen: 'frozen_food',
  cheese: 'chilled_cheese',
  butter: 'chilled_fats',
  ambient_liquids: 'syrups_crushes',
  oils: 'cooking_oils',
  dry_goods: 'dry_staples',
  dry_ingredients: 'dry_staples',
  beverages: 'packaged_beverages',
};

const bySlug = new Map(PRODUCT_CATEGORIES.map((c) => [c.productCategory, c]));

export function normalizeProductCategory(raw?: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s\-]+/g, '_');
  if (!key) return null;
  if (bySlug.has(key)) return key;
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  // Fuzzy human labels
  for (const c of PRODUCT_CATEGORIES) {
    if (c.label.toLowerCase().replace(/[\s\-]+/g, '_') === key) return c.productCategory;
    if (c.productCategory === key) return c.productCategory;
  }
  return key;
}

export function getCategoryDef(raw?: string | null): ProductCategoryDef | null {
  const slug = normalizeProductCategory(raw);
  if (!slug) return null;
  return bySlug.get(slug) ?? null;
}

/**
 * Strictest shelf rules across RFQ line items:
 * - highest minRslDays (must satisfy every line category)
 * - highest totalShelfLifeDays as default total (so default shelf ≥ min RSL)
 */
export function shelfRulesForItems(
  items: Array<{ productCategory?: string | null }>,
): { minRslDays: number; totalShelfLifeDays: number; categories: string[]; notes: string[] } {
  const defs = items
    .map((i) => getCategoryDef(i.productCategory))
    .filter((d): d is ProductCategoryDef => d != null);

  if (defs.length === 0) {
    // Fallback: ultra-fresh dairy-ish defaults from doc when category missing
    return {
      minRslDays: 2,
      totalShelfLifeDays: 5,
      categories: [],
      notes: ['No product category on items — using default min RSL 2d / shelf 5d'],
    };
  }

  let minRslDays = 0;
  let totalShelfLifeDays = 0;
  const categories: string[] = [];
  const notes: string[] = [];
  for (const d of defs) {
    minRslDays = Math.max(minRslDays, d.minRslDays);
    totalShelfLifeDays = Math.max(totalShelfLifeDays, d.totalShelfLifeDays);
    categories.push(d.productCategory);
    if (d.notes) notes.push(`${d.productCategory}: ${d.notes}`);
  }

  // Guarantee default total always covers the strictest min RSL for the cart
  totalShelfLifeDays = Math.max(totalShelfLifeDays, minRslDays);

  return {
    minRslDays,
    totalShelfLifeDays,
    categories: [...new Set(categories)],
    notes,
  };
}

export function categorySlugs(): string[] {
  return PRODUCT_CATEGORIES.map((c) => c.productCategory);
}
