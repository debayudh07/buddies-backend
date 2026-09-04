/**
 * Product category cart + shelf-life / return windows from "The buddies (1).docx".
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

const DRY_REASONS = ['moisture', 'torn_pack', 'pest'] as const;
const PRODUCE_REASONS = ['rotting', 'bruising', 'wrong_weight', 'visual_infestation'] as const;
const PROTEIN_REASONS = ['discoloration', 'off_odor', 'temp_abuse'] as const;
const CHILLED_REASONS = ['thawed', 'bloating', 'broken_seal'] as const;

/** Full categorical cart — one row per selectable product category. */
export const PRODUCT_CATEGORIES: ProductCategoryDef[] = [
  {
    productCategory: 'dairy',
    label: 'Dairy',
    exampleItems: 'Fresh pouch milk, curd, paneer, lassi, tofu',
    totalShelfLifeDays: 5,
    minRslDays: 2,
    windowHours: 1,
    validReasons: ['cold_chain_break', 'leakage', 'low_rsl'],
    notes: 'Doc: cold-chain breakdown, leakage, or less than 2 days remaining',
  },
  {
    productCategory: 'meat_poultry',
    label: 'Meat & Poultry',
    exampleItems: 'Chicken, mutton, liver, mince',
    totalShelfLifeDays: 3,
    minRslDays: 1,
    windowHours: 1,
    validReasons: [...PROTEIN_REASONS],
    notes: 'Doc: discoloration, off-odor, temperature abuse (>6 C on arrival)',
  },
  {
    productCategory: 'seafood_eggs',
    label: 'Seafood & Eggs',
    exampleItems: 'Rohu, prawns, crab, chicken eggs, duck eggs',
    totalShelfLifeDays: 3,
    minRslDays: 1,
    windowHours: 1,
    validReasons: [...PROTEIN_REASONS],
    notes: 'Doc: discoloration, off-odor, temperature abuse (>6 C on arrival)',
  },
  {
    productCategory: 'bakery_perishables',
    label: 'Bakery (Perishables)',
    exampleItems: 'Fresh bread, buns, croissants',
    totalShelfLifeDays: 5,
    minRslDays: 3,
    windowHours: 1,
    validReasons: ['leakage', 'low_rsl'],
    notes: 'Doc: package leakage or short shelf life',
  },
  {
    productCategory: 'vegetables',
    label: 'Vegetables',
    exampleItems: 'Onion, potato, tomato, leafy greens',
    totalShelfLifeDays: 5,
    minRslDays: 2,
    windowHours: 2,
    validReasons: [...PRODUCE_REASONS],
  },
  {
    productCategory: 'fruits',
    label: 'Fruits',
    exampleItems: 'Apple, banana, mango, citrus',
    totalShelfLifeDays: 5,
    minRslDays: 2,
    windowHours: 2,
    validReasons: [...PRODUCE_REASONS],
  },
  {
    productCategory: 'chilled_dairy',
    label: 'Chilled Dairy',
    exampleItems: 'Butter, margarine, mozzarella, cheddar, whipping cream',
    totalShelfLifeDays: 270,
    minRslDays: 60,
    windowHours: 4,
    validReasons: [...CHILLED_REASONS],
    notes: 'Doc: defrosted/thawed, severe bloating, or broken seals',
  },
  {
    productCategory: 'frozen_food',
    label: 'Frozen Foods',
    exampleItems: 'Frozen fries, veg patties, frozen purees',
    totalShelfLifeDays: 540,
    minRslDays: 120,
    windowHours: 4,
    validReasons: [...CHILLED_REASONS],
    notes: 'Doc: defrosted/thawed, severe bloating, or broken seals',
  },
  {
    productCategory: 'oils_fats',
    label: 'Oils & Fats',
    exampleItems: 'Mustard, sunflower, rice bran oil, ghee, vanaspati',
    totalShelfLifeDays: 365,
    minRslDays: 60,
    windowHours: 24,
    validReasons: ['cap_damage', 'low_rsl'],
    notes: 'Doc: cap damage or remaining shelf life less than 60 days',
  },
  {
    productCategory: 'sauces_condiments',
    label: 'Sauces & Condiments',
    exampleItems: 'Ketchup, mayonnaise, chutney, pickles',
    totalShelfLifeDays: 365,
    minRslDays: 60,
    windowHours: 24,
    validReasons: ['cap_damage', 'low_rsl'],
    notes: 'Doc: cap damage or remaining shelf life less than 60 days',
  },
  {
    productCategory: 'syrups_crushes',
    label: 'Syrups, Crushes & Purees',
    exampleItems: 'Fruit crushes, flavored syrups, dessert sauces',
    totalShelfLifeDays: 1080,
    minRslDays: 60,
    windowHours: 24,
    validReasons: ['cap_damage', 'crystallization', 'low_rsl'],
    notes: 'Doc: cap damage, crystallization (syrups), or remaining shelf life less than 60 days',
  },
  {
    productCategory: 'beverages',
    label: 'Beverages',
    exampleItems: 'Soft drinks, soda, juices, packaged water',
    totalShelfLifeDays: 180,
    minRslDays: 45,
    windowHours: 24,
    validReasons: ['cap_damage', 'low_rsl'],
    notes: 'Doc: cap damage or low remaining shelf life',
  },
  {
    productCategory: 'rice_flours',
    label: 'Rice & Flours',
    exampleItems: 'Basmati, atta, maida, suji, sugar',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'dals_pulses',
    label: 'Dals & Pulses',
    exampleItems: 'Toor, moong, chana, rajma, masoor',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'spices_sugar',
    label: 'Spices & Sugar',
    exampleItems: 'Turmeric, chilli, jeera, garam masala',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'dry_fruits_nuts',
    label: 'Dry Fruits & Nuts',
    exampleItems: 'Almonds, cashews, raisins, makhana',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'tea_coffee_bakery_goods',
    label: 'Tea, Coffee & Bakery Goods',
    exampleItems: 'Assam tea, roasted coffee, yeast, cake premix',
    totalShelfLifeDays: 365,
    minRslDays: 90,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'chocolate_cocoa',
    label: 'Chocolate & Cocoa',
    exampleItems: 'Dark/milk chocolate, cocoa powder, chips',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: [...DRY_REASONS],
  },
  {
    productCategory: 'packaging_disposables',
    label: 'Packaging & Disposables',
    exampleItems: 'Foil, containers, boxes, cups, bags',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: ['torn_pack', 'contamination'],
  },
  {
    productCategory: 'cleaning_utility',
    label: 'Cleaning & Utility Supplies',
    exampleItems: 'Dishwash, sanitizer, mops, gloves, garbage bags',
    totalShelfLifeDays: 730,
    minRslDays: 180,
    windowHours: 48,
    validReasons: ['torn_pack', 'product_damage'],
  },
];

/** Older seed/app labels → current cart slug. */
const CATEGORY_ALIASES: Record<string, string> = {
  ultra_fresh_dairy: 'dairy',
  ultra_perishables_dairy: 'dairy',
  ultra_fresh_perishables: 'dairy',
  ultra_fresh_bakery: 'bakery_perishables',
  bakery: 'bakery_perishables',
  bread: 'bakery_perishables',
  fresh_proteins: 'meat_poultry',
  proteins: 'meat_poultry',
  meat: 'meat_poultry',
  fresh_produce: 'vegetables',
  produce: 'vegetables',
  chilled_cheese: 'chilled_dairy',
  chilled_fats: 'chilled_dairy',
  cheese: 'chilled_dairy',
  butter: 'chilled_dairy',
  cooking_oils: 'oils_fats',
  oils: 'oils_fats',
  packaged_beverages: 'beverages',
  coffee_roasted: 'tea_coffee_bakery_goods',
  dry_staples: 'rice_flours',
  dry_goods: 'rice_flours',
  dry_ingredients: 'rice_flours',
  chilled_frozen_fmcg: 'frozen_food',
  frozen: 'frozen_food',
  ambient_liquids: 'syrups_crushes',
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

/** Canonical 20-slug list plus older aliases that map to those slugs (for DB overlap queries). */
export function categoryMatchValues(canonical: string[]): string[] {
  const set = new Set<string>();
  for (const raw of canonical) {
    const def = getCategoryDef(raw);
    if (def) set.add(def.productCategory);
  }
  for (const [alias, target] of Object.entries(CATEGORY_ALIASES)) {
    if (set.has(target)) set.add(alias);
  }
  return [...set];
}

export function canonicalizeSupplierCategories(raw: string[]): {
  slugs: string[];
  unknown: string[];
} {
  const slugs = new Set<string>();
  const unknown: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const def = getCategoryDef(item);
    if (!def) unknown.push(item.trim());
    else slugs.add(def.productCategory);
  }
  return { slugs: [...slugs], unknown };
}

export function requestProductCategories(
  items: Array<{ productCategory?: string | null }>,
): string[] {
  const slugs = new Set<string>();
  for (const item of items) {
    const def = getCategoryDef(item.productCategory);
    if (def) slugs.add(def.productCategory);
  }
  return [...slugs];
}

export function supplierStocksCategory(
  supplierCategories: string[],
  productCategory?: string | null,
): boolean {
  const def = getCategoryDef(productCategory);
  if (!def) return false;
  const { slugs } = canonicalizeSupplierCategories(supplierCategories);
  return slugs.includes(def.productCategory);
}
