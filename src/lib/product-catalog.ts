/**
 * Commercial order catalog from "The buddies.pdf" (Category Item Names + MOQ).
 * Categories are the 20 restaurant carts; item names are the selectable subcategories.
 * Each item maps to a shelf/RSL productCategory slug from product-categories.ts.
 */

export type CatalogUnit = 'kg' | 'g' | 'L' | 'pcs';

export type CatalogItemDef = {
  slug: string;
  name: string;
  /** Shelf/RSL matrix slug (product-categories.ts). */
  productCategory: string;
};

export type CatalogCategoryDef = {
  slug: string;
  label: string;
  sortOrder: number;
  moqQty: number;
  moqUnit: CatalogUnit;
  items: CatalogItemDef[];
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function items(productCategory: string, names: string[]): CatalogItemDef[] {
  const seen = new Set<string>();
  const out: CatalogItemDef[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    let slug = slugify(name);
    if (seen.has(slug)) slug = `${slug}_${out.length}`;
    seen.add(slug);
    out.push({ slug, name, productCategory });
  }
  return out;
}

function mix(
  pairs: Array<{ productCategory: string; names: string[] }>,
): CatalogItemDef[] {
  return pairs.flatMap((p) => items(p.productCategory, p.names));
}

export const PRODUCT_CATALOG: CatalogCategoryDef[] = [
  {
    slug: 'rice_rice_products',
    label: 'Rice & Rice Products',
    sortOrder: 1,
    moqQty: 5,
    moqUnit: 'kg',
    items: items('rice_flours', [
      'Basmati Rice',
      'Aged Basmati (1121)',
      'Sona Masuri Rice',
      'Banshkathi Rice',
      'Idli Rice',
      'Dosa Rice',
      'Matta Rice',
      'Jeeraga Samba Rice',
      'Miniket Rice',
      'Swarna Rice',
      'Gobindobhog Rice',
      'Brown Rice',
      'Red Rice',
      'Black Rice',
      'Jeerakathi Rice',
      'Atop Rice',
      'Parboiled Rice',
      'Broken Rice',
      'Steam Rice',
      'Poha',
      'Sabudana',
      'Murmura',
      'Rice Flour',
      'Jasmine Rice',
    ]),
  },
  {
    slug: 'dals_pulses_legumes',
    label: 'Dals, Pulses & Legumes',
    sortOrder: 2,
    moqQty: 1,
    moqUnit: 'kg',
    items: items('dals_pulses', [
      'Toor Dal',
      'Arhar Dal',
      'Moong Dal',
      'Moong Dhuli',
      'Moong',
      'Whole Moong',
      'Urad Dal',
      'Urad Gota',
      'Chana Dal',
      'Kabuli Chana',
      'Kala Chana',
      'Masoor Dal',
      'Whole Masoor',
      'Rajma',
      'Tadka Dal',
      'Dried Peas',
      'Matki',
      'Moth Dal',
      'Kulith',
      'Soybean',
      'Soya Chunks',
    ]),
  },
  {
    slug: 'spices_indian_masala',
    label: 'Spices & Indian Masala',
    sortOrder: 3,
    moqQty: 500,
    moqUnit: 'g',
    items: items('spices_sugar', [
      'Turmeric',
      'Red Chilli Powder',
      'Kashmiri Chilli Powder',
      'Coriander Powder',
      'Cumin Powder',
      'Black Pepper Powder',
      'Jeera',
      'Coriander Seeds',
      'Mustard Seeds',
      'Fennel',
      'Meethi Beej',
      'Ajwain',
      'Kala Jeera',
      'Black Pepper',
      'Elaichi',
      'Kali Elaichi',
      'Cinnamon',
      'Tej Patta',
      'Daalchini',
      'Star Anise',
      'Clove',
      'Nutmeg',
      'Saffron',
      'Garam Masala',
      'Biryani Masala',
      'Chicken Masala',
      'Mutton Masala',
      'Chaat Masala',
      'Pav Bhaji Masala',
      'Chole Masala',
      'Rajma Masala',
      'Paneer Masala',
      'Sambar Masala',
      'Rasam Masala',
      'Fish Masala',
      'Meat Masala',
      'Gota Masala',
      'Panch Phoron',
    ]),
  },
  {
    slug: 'flours_sugar',
    label: 'Flours & Sugar',
    sortOrder: 4,
    moqQty: 5,
    moqUnit: 'kg',
    items: items('rice_flours', [
      'Wheat Atta',
      'Chakki Atta',
      'Multigrain Atta',
      'Maida',
      'Suji',
      'Rava',
      'Besan',
      'Rice Flour',
      'Corn Flour',
      'Corn Starch',
      'Ragi Flour',
      'Jowar Flour',
      'Bajra Flour',
      'Oats Flour',
      'Barley Flour',
      'White Sugar',
      'Brown Sugar',
      'Powdered Sugar',
      'Icing Sugar',
      'Mishri',
      'Jaggery',
      'Jaggery Powder',
    ]),
  },
  {
    slug: 'cooking_oils_fats',
    label: 'Cooking Oils & Fats',
    sortOrder: 5,
    moqQty: 5,
    moqUnit: 'L',
    items: items('oils_fats', [
      'Mustard Oil',
      'Sunflower Oil',
      'Soybean Oil',
      'Rice Bran Oil',
      'Groundnut Oil',
      'Coconut Oil',
      'Sesame Oil',
      'Palm Oil',
      'Blended Cooking Oil',
      'Olive Oil',
      'Wood Pressed Oil',
      'Kachi Ghani Oil',
      'Filtered Oil',
      'Organic Oil',
      'Vanaspati',
    ]),
  },
  {
    slug: 'fresh_dairy',
    label: 'Fresh Dairy',
    sortOrder: 6,
    moqQty: 2,
    moqUnit: 'L',
    items: mix([
      {
        productCategory: 'dairy',
        names: [
          'Full Cream Milk',
          'Toned Milk',
          'Double Toned Milk',
          'Fresh Milk',
          'Curd',
          'Dahi',
          'Greek Yogurt',
          'Paneer',
          'Fresh Cream',
          'Whipping Cream',
          'Buttermilk',
          'Lassi',
          'Flavoured Lassi',
          'Khoya',
          'Mawa',
          'Yogurt',
          'Tofu',
          'Soy Milk',
          'Almond Milk',
        ],
      },
      {
        productCategory: 'oils_fats',
        names: [
          'Cow Ghee',
          'Buffalo Ghee',
          'Desi Ghee',
        ],
      },
      {
        productCategory: 'chilled_dairy',
        names: [
          'Margarine',
          'Butter',
        ],
      },
    ]),
  },
  {
    slug: 'butter_cheese',
    label: 'Butter & Cheese',
    sortOrder: 7,
    moqQty: 1,
    moqUnit: 'kg',
    items: mix([
      {
        productCategory: 'chilled_dairy',
        names: [
          'Salted Butter',
          'Unsalted Butter',
          'Cooking Butter',
          'Garlic Butter',
          'Margarine',
        ],
      },
      {
        productCategory: 'chilled_dairy',
        names: [
          'Mozzarella Cheese',
          'Cheddar Cheese',
          'Processed Cheese',
          'Cheese Slices',
          'Cheese Blocks',
          'Cheese Cubes',
          'Cream Cheese',
          'Cheese Spread',
          'Pizza Cheese',
          'Cheese Blend',
          'Parmesan Cheese',
          'Feta Cheese',
          'Cheese Sauce',
          'Grated Cheese',
        ],
      },
    ]),
  },
  {
    slug: 'meat_poultry_seafood_eggs',
    label: 'Meat, Poultry, Seafood & Eggs',
    sortOrder: 8,
    moqQty: 1,
    moqUnit: 'kg',
    items: mix([
      {
        productCategory: 'meat_poultry',
        names: [
          'Whole Chicken',
          'Chicken Boneless',
          'Chicken Breast',
          'Chicken Thigh',
          'Chicken Leg',
          'Chicken Drumstick',
          'Chicken Wings',
          'Chicken Lollipop',
          'Chicken Mince',
          'Chicken Liver',
          'Mutton Biryani Cut',
          'Mutton Boneless',
          'Mutton Raan',
          'Mutton Chops',
          'Mutton Shank',
          'Mutton Mince',
          'Paya',
          'Mutton Liver',
        ],
      },
      {
        productCategory: 'seafood_eggs',
        names: [
          'Rohu',
          'Katla',
          'Basa',
          'Bhetki',
          'Magur',
          'Singhi',
          'Pabda',
          'Hilsa',
          'Pomfret',
          'Prawns',
          'Shrimp',
          'Crab',
          'Squid',
          'Poultry Eggs',
          'Chicken Eggs',
          'Duck Eggs',
        ],
      },
    ]),
  },
  {
    slug: 'fruits',
    label: 'Fruits',
    sortOrder: 9,
    moqQty: 5,
    moqUnit: 'kg',
    items: items('fruits', [
      'Apple',
      'Banana',
      'Orange',
      'Mosambi',
      'Lemon',
      'Mango',
      'Alphonso Mango',
      'Kesar Mango',
      'Dasheri Mango',
      'Langra Mango',
      'Himsagar Mango',
      'Banganapalli Mango',
      'Totapuri Mango',
      'Chausa Mango',
      'Guava',
      'Papaya',
      'Pomegranate',
      'Grapes',
      'Chikoo',
      'Pineapple',
      'Watermelon',
      'Muskmelon',
      'Coconut',
      'Avocado',
      'Kiwi',
      'Dragon Fruit',
      'Blueberry',
      'Strawberry',
    ]),
  },
  {
    slug: 'dry_fruits_nuts',
    label: 'Dry Fruits & Nuts',
    sortOrder: 10,
    moqQty: 5,
    moqUnit: 'kg',
    items: items('dry_fruits_nuts', [
      'Almonds',
      'Cashews',
      'Pistachios',
      'Walnuts',
      'Raisins',
      'Black Raisins',
      'Munakka',
      'Dried Figs',
      'Dates',
      'Dry Dates',
      'Dried Apricots',
      'Chilgoza',
      'Fox Nuts',
      'Pumpkin Seeds',
      'Sunflower Seeds',
      'Watermelon Seeds',
      'Chia Seeds',
      'Flax Seeds',
      'Sesame Seeds',
      'Dried Cranberries',
      'Dried Blueberries',
      'Brazil Nuts',
      'Hazelnuts',
      'Pecans',
      'Mixed Dry Fruits',
      'Roasted Almonds',
      'Roasted Cashews',
      'Roasted Fox Nuts',
    ]),
  },
  {
    slug: 'vegetables',
    label: 'Vegetables',
    sortOrder: 11,
    moqQty: 10,
    moqUnit: 'kg',
    items: items('vegetables', [
      'Onion',
      'Potato',
      'Tomato',
      'Garlic',
      'Ginger',
      'Green Chilli',
      'Carrot',
      'Beetroot',
      'Radish',
      'Shalgam',
      'Spinach',
      'Methi',
      'Coriander',
      'Mint',
      'Curry Leaves',
      'Lettuce',
      'Bhindi',
      'Brinjal',
      'Corola',
      'Jhinga',
      'Pumpkin',
      'Drumstick',
      'Tinda',
      'Cluster Beans',
      'Kudri',
      'Cauliflower',
      'Cabbage',
      'Green Peas',
      'Capsicum',
      'Sweet Corn',
      'Mushroom',
      'Broccoli',
      'Zucchini',
      'Cherry Tomato',
      'Baby Corn',
      'Asparagus',
      'Red Bell Pepper',
      'Yellow Bell Pepper',
    ]),
  },
  {
    slug: 'bakery_ingredients_essentials',
    label: 'Bakery Ingredients & Essentials',
    sortOrder: 12,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('tea_coffee_bakery_goods', [
      'Yeast',
      'Baking Powder',
      'Baking Soda',
      'Cake Premix',
      'Chocolate Cake Premix',
      'Vanilla Cake Premix',
      'Brownie Premix',
      'Bread Improver',
      'Cake Gel',
      'Cake Stabilizer',
      'Custard Powder',
      'Corn Flour',
      'Breadcrumbs',
      'Vanilla Essence',
      'Food Flavours',
      'Food Colours',
      'Gel Colours',
      'Fondant',
      'Whipping Cream Powder',
      'Sprinkles',
      'Cake Toppers',
    ]),
  },
  {
    slug: 'chocolate_cocoa',
    label: 'Chocolate & Cocoa',
    sortOrder: 13,
    moqQty: 5,
    moqUnit: 'kg',
    items: items('chocolate_cocoa', [
      'Dark Chocolate',
      'Milk Chocolate',
      'White Chocolate',
      'Compound Chocolate',
      'Baking Chocolate',
      'Chocolate Callets',
      'Chocolate Chunks',
      'Cocoa Powder',
      'Drinking Chocolate',
      'Chocolate Chips',
      'Mini Chocolate Chips',
      'Chocolate Shavings',
      'Chocolate Vermicelli',
      'Chocolate Decorations',
    ]),
  },
  {
    slug: 'sauces_condiments_dips',
    label: 'Sauces, Condiments & Dips',
    sortOrder: 14,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('sauces_condiments', [
      'Tomato Ketchup',
      'Mayonnaise',
      'Eggless Mayonnaise',
      'Mustard Sauce',
      'Green Chilli Sauce',
      'Red Chilli Sauce',
      'Soya Sauce',
      'Schezwan Sauce',
      'Manchurian Sauce',
      'BBQ Sauce',
      'Pizza Sauce',
      'Pasta Sauce',
      'Hot Sauce',
      'Cheese Sauce',
      'Garlic Sauce',
      'Thousand Island Dressing',
      'Ranch Dressing',
      'Tartar Sauce',
      'White Vinegar',
      'Apple Cider Vinegar',
      'Rice Vinegar',
      'Mint Chutney',
      'Tamarind Chutney',
      'Coconut Chutney',
      'Mango Chutney',
      'Pickles',
    ]),
  },
  {
    slug: 'syrups_crushes_purees',
    label: 'Syrups, Crushes & Purees',
    sortOrder: 15,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('syrups_crushes', [
      'Mango Crush',
      'Orange Crush',
      'Pineapple Crush',
      'Strawberry Crush',
      'Raspberry Crush',
      'Blueberry Crush',
      'Blackcurrant Crush',
      'Green Apple Crush',
      'Passion Fruit Crush',
      'Vanilla Syrup',
      'Caramel Syrup',
      'Hazelnut Syrup',
      'Chocolate Syrup',
      'Strawberry Syrup',
      'Blue Curacao Syrup',
      'Rose Syrup',
      'Kesar Syrup',
      'Falooda Syrup',
      'Kala Khatta Syrup',
      'Mango Puree',
      'Strawberry Puree',
      'Passion Fruit Puree',
      'Guava Puree',
      'Pineapple Puree',
      'Chocolate Sauce',
      'Caramel Sauce',
      'Strawberry Dessert Sauce',
      'Butterscotch Sauce',
    ]),
  },
  {
    slug: 'tea_coffee',
    label: 'Tea & Coffee',
    sortOrder: 16,
    moqQty: 1,
    moqUnit: 'kg',
    items: mix([
      {
        productCategory: 'tea_coffee_bakery_goods',
        names: [
          'Assam Tea',
          'Darjeeling Tea',
          'Nilgiri Tea',
          'CTC Tea',
          'Loose Leaf Tea',
          'Green Tea',
          'Masala Tea',
          'Ginger Tea',
          'Elaichi Tea',
          'Lemon Tea',
          'Herbal Tea',
          'Tea Bags',
          'Instant Coffee',
          'Filter Coffee Powder',
          'Coffee',
          'Ground Coffee',
          'Roasted Coffee Beans',
          'Arabica Coffee',
          'Espresso Blend',
          'Coffee Premix',
          'Cold Coffee Mix',
        ],
      },
    ]),
  },
  {
    slug: 'cold_non_alcoholic_beverages',
    label: 'Cold & Non-Alcoholic Beverages',
    sortOrder: 17,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('beverages', [
      'Soft Drinks',
      'Soda',
      'Tonic Water',
      'Club Soda',
      'Mixers',
      'Packaged Water',
      'Mineral Water',
      'Packaged Juices',
      'Fruit Drinks',
      'Coconut Water',
      'Energy Drinks',
      'Sports Drinks',
      'Iced Tea',
      'Flavoured Milk',
      'Milkshakes',
      'Drink Concentrates',
      'Sharbat',
      'Aam Panna',
      'Jaljeera',
      'Kokum Sharbat',
      'Nimbu Pani',
      'Thandai',
      'Lassi',
      'Chaas',
    ]),
  },
  {
    slug: 'packaging_disposables',
    label: 'Packaging & Disposables',
    sortOrder: 18,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('packaging_disposables', [
      'Aluminium Foil',
      'Commercial Aluminium Foil Rolls',
      'Baking Paper',
      'Parchment Paper',
      'Butter Paper',
      'Cling Film',
      'Food Wrap Paper',
      'Greaseproof Paper',
      'Wax Paper',
      'Freezer Bags',
      'Ziplock Bags',
      'Vacuum Bags',
      'Food Grade Sheets',
      'Plastic Food Containers',
      'PP Containers',
      'PET Containers',
      'Microwave Containers',
      'Hinged Containers',
      'Leakproof Containers',
      'Biryani Boxes',
      'Meal Boxes',
      'Burger Boxes',
      'Pizza Boxes',
      'Sandwich Boxes',
      'Noodle Boxes',
      'Chinese Food Boxes',
      'Mithai Boxes',
      'Cake Boxes',
      'Pastry Boxes',
      'Cupcake Boxes',
      'Cake Boards',
      'Cake Trays',
      'Piping Bags',
      'Cupcake Liners',
      'Paper Cups',
      'Plastic Cups',
      'Paper Bowls',
      'Paper Plates',
      'Bagasse Plates',
      'Bagasse Bowls',
      'Wooden Spoons',
      'Wooden Forks',
      'Wooden Knives',
      'Straws',
      'Stirrers',
      'Paper Carry Bags',
      'Kraft Bags',
      'Food Delivery Bags',
      'Sauce Containers',
      'Tissue Papers',
      'Napkins',
    ]),
  },
  {
    slug: 'commercial_kitchen_cleaning',
    label: 'Commercial Kitchen Cleaning',
    sortOrder: 19,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('cleaning_utility', [
      'Dishwash Liquid',
      'Dishwash Gel',
      'Dishwash Powder',
      'Dishwasher Detergent',
      'Dishwasher Rinse Aid',
      'Kitchen Degreaser',
      'Oven Cleaner',
      'Chimney Cleaner',
      'Exhaust Cleaner',
      'Stainless Steel Cleaner',
      'Food Safe Sanitizer',
      'Surface Sanitizer',
      'Kitchen Sanitizer',
      'Hand Wash',
      'Hand Sanitizer',
      'Floor Cleaner',
      'Glass Cleaner',
      'Drain Cleaner',
      'Toilet Cleaner',
    ]),
  },
  {
    slug: 'kitchen_utility_hygiene',
    label: 'Kitchen Utility & Hygiene Supplies',
    sortOrder: 20,
    moqQty: 2,
    moqUnit: 'pcs',
    items: items('cleaning_utility', [
      'Mop Heads',
      'Mops',
      'Floor Squeegees',
      'Scrubbers',
      'Sponges',
      'Dish Brushes',
      'Bottle Brushes',
      'Floor Brushes',
      'Kitchen Dusters',
      'Microfiber Cloths',
      'Cleaning Wipes',
      'Disposable Gloves',
      'Hair Nets',
      'Hair Caps',
      'Beard Covers',
      'Face Masks',
      'Disposable Aprons',
      'Garbage Bags',
      'Bin Liners',
      'Food Waste Bags',
      'Garbage Bins',
    ]),
  },
];

const categoryBySlug = new Map(PRODUCT_CATALOG.map((c) => [c.slug, c]));
const itemIndex = new Map<string, { category: CatalogCategoryDef; item: CatalogItemDef }>();
for (const cat of PRODUCT_CATALOG) {
  for (const item of cat.items) {
    itemIndex.set(`${cat.slug}:${item.slug}`, { category: cat, item });
  }
}

export function getCatalogCategory(slug?: string | null): CatalogCategoryDef | null {
  if (!slug) return null;
  return categoryBySlug.get(slug.trim()) ?? null;
}

export function resolveCatalogItem(
  catalogCategory: string,
  catalogItemSlug: string,
): { category: CatalogCategoryDef; item: CatalogItemDef } | null {
  return itemIndex.get(`${catalogCategory}:${catalogItemSlug}`) ?? null;
}

export const BEVERAGE_CATALOG_SLUG = 'cold_non_alcoholic_beverages';
export const PIECE_PACK_SIZES = ['Small', 'Medium', 'Large'] as const;
export const BEVERAGE_PACK_SIZES = ['180ml', '250ml', '750ml', '1L', '2L'] as const;
export type PackSizeKind = 'piece' | 'beverage';

export function packSizeKindForCategory(
  cat: CatalogCategoryDef | string | null | undefined,
): PackSizeKind | null {
  const resolved = typeof cat === 'string' ? getCatalogCategory(cat) : cat;
  if (!resolved) return null;
  if (resolved.slug === BEVERAGE_CATALOG_SLUG) return 'beverage';
  if (resolved.moqUnit === 'pcs') return 'piece';
  return null;
}

export function packSizeOptionsForKind(kind: PackSizeKind | null): string[] {
  if (kind === 'beverage') return [...BEVERAGE_PACK_SIZES];
  if (kind === 'piece') return [...PIECE_PACK_SIZES];
  return [];
}

export function presentCatalog(opts?: { q?: string; category?: string; previewLimit?: number }) {
  const q = (opts?.q ?? '').trim().toLowerCase();
  const categoryFilter = opts?.category?.trim();
  const previewLimit = opts?.previewLimit ?? 10;

  let cats = PRODUCT_CATALOG;
  if (categoryFilter) {
    cats = cats.filter((c) => c.slug === categoryFilter);
  }

  const match = (label: string) => !q || label.toLowerCase().includes(q);

  const mapped = cats
    .map((c) => {
      const itemsOut = q
        ? c.items.filter((i) => match(i.name) || match(c.label))
        : c.items;
      const categoryHit = match(c.label);
      if (q && !categoryHit && itemsOut.length === 0) return null;
      return {
        slug: c.slug,
        label: c.label,
        sortOrder: c.sortOrder,
        moqQty: c.moqQty,
        moqUnit: c.moqUnit,
        packSizeKind: packSizeKindForCategory(c),
        packSizeOptions: packSizeOptionsForKind(packSizeKindForCategory(c)),
        itemCount: c.items.length,
        items: (q ? itemsOut : c.items).map((i) => ({
          slug: i.slug,
          name: i.name,
          productCategory: i.productCategory,
        })),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);

  const preview = !q && !categoryFilter ? mapped.slice(0, previewLimit) : mapped;

  return {
    categories: preview,
    totalCategories: PRODUCT_CATALOG.length,
    showingFirst: !q && !categoryFilter ? previewLimit : mapped.length,
    cartRule: {
      minLines: 3,
      fallbackWeightKg: 20,
      note: 'At least 3 line items, or total weight of 20 kg when fewer than 3 lines.',
    },
  };
}

export type IncomingCatalogLine = {
  catalogCategory?: string;
  catalogItemSlug?: string;
  name?: string;
  quantity: number;
  unit?: string;
  productCategory?: string;
  gradeHint?: string;
  packSize?: string;
};

export type CanonicalLine = {
  catalogCategory: string;
  catalogItemSlug: string;
  name: string;
  quantity: number;
  unit: CatalogUnit;
  productCategory: string;
  minimumOrderQty: number;
  minimumOrderUnit: CatalogUnit;
  gradeHint?: string;
  packSize?: string;
};

function normalizeUnit(raw?: string | null): CatalogUnit | null {
  if (!raw) return null;
  const u = raw.trim().toLowerCase();
  if (u === 'kg' || u === 'kgs' || u === 'kilogram' || u === 'kilograms') return 'kg';
  if (u === 'g' || u === 'gm' || u === 'gms' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'l' || u === 'lt' || u === 'ltr' || u === 'litre' || u === 'liter' || u === 'litres') {
    return 'L';
  }
  if (u === 'pcs' || u === 'pc' || u === 'piece' || u === 'pieces' || u === 'box') return 'pcs';
  return null;
}

/** Convert quantity into the category MOQ unit when units are compatible. */
export function quantityInUnit(
  quantity: number,
  fromUnit: CatalogUnit,
  toUnit: CatalogUnit,
): number | null {
  if (fromUnit === toUnit) return quantity;
  if (fromUnit === 'g' && toUnit === 'kg') return quantity / 1000;
  if (fromUnit === 'kg' && toUnit === 'g') return quantity * 1000;
  return null;
}

export function lineWeightKg(quantity: number, unit: CatalogUnit): number {
  if (unit === 'kg') return quantity;
  if (unit === 'g') return quantity / 1000;
  return 0;
}

export type CatalogResolveError = {
  code:
    | 'UNKNOWN_CATEGORY'
    | 'UNKNOWN_ITEM'
    | 'CATEGORY_ITEM_MISMATCH'
    | 'INVALID_UNIT'
    | 'MOQ_BELOW_MINIMUM'
    | 'PACK_SIZE_REQUIRED'
    | 'INVALID_PACK_SIZE';
  message: string;
};

export function canonicalizeLine(input: IncomingCatalogLine): CanonicalLine | CatalogResolveError {
  const catSlug = input.catalogCategory?.trim();
  const itemSlug = input.catalogItemSlug?.trim();
  if (!catSlug || !itemSlug) {
    return {
      code: 'UNKNOWN_ITEM',
      message: 'Each line must include catalogCategory and catalogItemSlug',
    };
  }
  const resolved = resolveCatalogItem(catSlug, itemSlug);
  if (!resolved) {
    const cat = getCatalogCategory(catSlug);
    if (!cat) {
      return { code: 'UNKNOWN_CATEGORY', message: `Unknown catalog category: ${catSlug}` };
    }
    return {
      code: 'CATEGORY_ITEM_MISMATCH',
      message: `Item ${itemSlug} is not in category ${cat.label}`,
    };
  }

  const unit = normalizeUnit(input.unit) ?? resolved.category.moqUnit;
  const qtyInMoq = quantityInUnit(input.quantity, unit, resolved.category.moqUnit);
  if (qtyInMoq == null) {
    return {
      code: 'INVALID_UNIT',
      message: `Use ${resolved.category.moqUnit} for ${resolved.category.label}`,
    };
  }
  if (qtyInMoq + 1e-9 < resolved.category.moqQty) {
    return {
      code: 'MOQ_BELOW_MINIMUM',
      message: `Minimum order for ${resolved.item.name} is ${resolved.category.moqQty} ${resolved.category.moqUnit}`,
    };
  }

  const packKind = packSizeKindForCategory(resolved.category);
  const packOptions = packSizeOptionsForKind(packKind);
  const packSize = input.packSize?.trim() || undefined;
  if (packKind) {
    if (!packSize) {
      return {
        code: 'PACK_SIZE_REQUIRED',
        message: `Pick a pack size (${packOptions.join(', ')}) for ${resolved.item.name}`,
      };
    }
    if (!packOptions.includes(packSize)) {
      return {
        code: 'INVALID_PACK_SIZE',
        message: `Pack size must be one of: ${packOptions.join(', ')}`,
      };
    }
  }

  return {
    catalogCategory: resolved.category.slug,
    catalogItemSlug: resolved.item.slug,
    name: resolved.item.name,
    quantity: input.quantity,
    unit,
    productCategory: resolved.item.productCategory,
    minimumOrderQty: resolved.category.moqQty,
    minimumOrderUnit: resolved.category.moqUnit,
    gradeHint: input.gradeHint,
    packSize: packKind ? packSize : undefined,
  };
}

export type CartRuleError = {
  code: 'CART_MINIMUM_NOT_MET';
  message: string;
};

export function assertCartRule(lines: CanonicalLine[]): CartRuleError | null {
  if (lines.length >= 3) return null;
  const weightKg = lines.reduce((sum, l) => sum + lineWeightKg(l.quantity, l.unit), 0);
  if (weightKg + 1e-9 >= 20) return null;
  return {
    code: 'CART_MINIMUM_NOT_MET',
    message:
      'Add at least 3 items, or keep the cart at 20 kg or more when ordering fewer lines',
  };
}

export function presentCategory(c: CatalogCategoryDef) {
  const packSizeKind = packSizeKindForCategory(c);
  return {
    slug: c.slug,
    label: c.label,
    sortOrder: c.sortOrder,
    moqQty: c.moqQty,
    moqUnit: c.moqUnit,
    packSizeKind,
    packSizeOptions: packSizeOptionsForKind(packSizeKind),
    itemCount: c.items.length,
  };
}
