import {
  PRODUCT_CATALOG,
  presentCatalog,
  canonicalizeLine,
  assertCartRule,
  quantityInUnit,
  lineWeightKg,
  type CanonicalLine,
} from '../src/lib/product-catalog';

let failed = 0;
function assert(name: string, cond: boolean, detail?: unknown) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', name, detail ?? '');
  } else {
    console.log('OK', name);
  }
}

function mustCanon(input: Parameters<typeof canonicalizeLine>[0]): CanonicalLine {
  const r = canonicalizeLine(input);
  if ('code' in r) throw new Error(`${r.code}: ${r.message}`);
  return r;
}

assert('20 categories', PRODUCT_CATALOG.length === 20, PRODUCT_CATALOG.length);
assert('first 10 preview', presentCatalog().categories.length === 10);
assert('search rice', presentCatalog({ q: 'basmati' }).categories.length >= 1);
assert(
  'category filter',
  presentCatalog({ category: 'vegetables' }).categories[0]?.slug === 'vegetables',
);

const veg = canonicalizeLine({
  catalogCategory: 'vegetables',
  catalogItemSlug: 'onion',
  quantity: 10,
  unit: 'kg',
});
assert('onion 10kg', !('code' in veg) && veg.name === 'Onion');

const vegLow = canonicalizeLine({
  catalogCategory: 'vegetables',
  catalogItemSlug: 'onion',
  quantity: 5,
  unit: 'kg',
});
assert('onion moq', 'code' in vegLow && vegLow.code === 'MOQ_BELOW_MINIMUM');

const spice = canonicalizeLine({
  catalogCategory: 'spices_indian_masala',
  catalogItemSlug: 'turmeric',
  quantity: 500,
  unit: 'g',
});
assert('turmeric 500g', !('code' in spice));

const spiceKg = canonicalizeLine({
  catalogCategory: 'spices_indian_masala',
  catalogItemSlug: 'turmeric',
  quantity: 0.5,
  unit: 'kg',
});
assert('turmeric 0.5kg converts', !('code' in spiceKg));

const mismatch = canonicalizeLine({
  catalogCategory: 'vegetables',
  catalogItemSlug: 'basmati_rice',
  quantity: 10,
  unit: 'kg',
});
assert('mismatch', 'code' in mismatch && mismatch.code === 'CATEGORY_ITEM_MISMATCH');

const pieces = canonicalizeLine({
  catalogCategory: 'sauces_condiments_dips',
  catalogItemSlug: 'tomato_ketchup',
  quantity: 2,
  unit: 'pcs',
  packSize: 'Medium',
});
assert('ketchup 2pcs', !('code' in pieces) && pieces.packSize === 'Medium');

const onePiece = canonicalizeLine({
  catalogCategory: 'sauces_condiments_dips',
  catalogItemSlug: 'tomato_ketchup',
  quantity: 1,
  unit: 'pcs',
});
assert('ketchup 1pc blocked', 'code' in onePiece && onePiece.code === 'MOQ_BELOW_MINIMUM');

const twoLines = [
  mustCanon({ catalogCategory: 'vegetables', catalogItemSlug: 'onion', quantity: 10, unit: 'kg' }),
  mustCanon({
    catalogCategory: 'rice_rice_products',
    catalogItemSlug: 'sona_masuri_rice',
    quantity: 5,
    unit: 'kg',
  }),
];
assert('cart 2 lines 15kg fail', assertCartRule(twoLines)?.code === 'CART_MINIMUM_NOT_MET');

const twoHeavy = [
  mustCanon({ catalogCategory: 'vegetables', catalogItemSlug: 'onion', quantity: 10, unit: 'kg' }),
  mustCanon({
    catalogCategory: 'rice_rice_products',
    catalogItemSlug: 'sona_masuri_rice',
    quantity: 10,
    unit: 'kg',
  }),
];
assert('cart 2 lines 20kg ok', assertCartRule(twoHeavy) === null);

const threeLight = [
  mustCanon({
    catalogCategory: 'sauces_condiments_dips',
    catalogItemSlug: 'tomato_ketchup',
    quantity: 2,
    unit: 'pcs',
    packSize: 'Medium',
  }),
  mustCanon({
    catalogCategory: 'bakery_ingredients_essentials',
    catalogItemSlug: 'yeast',
    quantity: 2,
    unit: 'pcs',
    packSize: 'Small',
  }),
  mustCanon({ catalogCategory: 'tea_coffee', catalogItemSlug: 'assam_tea', quantity: 1, unit: 'kg' }),
];
assert('cart 3 lines ok', assertCartRule(threeLight) === null);

assert('g to kg', quantityInUnit(500, 'g', 'kg') === 0.5);
assert('kg weight', lineWeightKg(10, 'kg') === 10);
assert('L not weight', lineWeightKg(5, 'L') === 0);

const ketchupNoPack = canonicalizeLine({
  catalogCategory: 'sauces_condiments_dips',
  catalogItemSlug: 'tomato_ketchup',
  quantity: 2,
  unit: 'pcs',
});
assert('ketchup pack required', 'code' in ketchupNoPack && ketchupNoPack.code === 'PACK_SIZE_REQUIRED');

const beverage = canonicalizeLine({
  catalogCategory: 'cold_non_alcoholic_beverages',
  catalogItemSlug: 'soft_drinks',
  quantity: 2,
  unit: 'pcs',
  packSize: '250ml',
});
assert('soft drink 250ml', !('code' in beverage) && beverage.packSize === '250ml');

const beverageBad = canonicalizeLine({
  catalogCategory: 'cold_non_alcoholic_beverages',
  catalogItemSlug: 'soft_drinks',
  quantity: 2,
  unit: 'pcs',
  packSize: 'Small',
});
assert('soft drink wrong pack', 'code' in beverageBad && beverageBad.code === 'INVALID_PACK_SIZE');

const riceNoPack = canonicalizeLine({
  catalogCategory: 'rice_rice_products',
  catalogItemSlug: 'basmati_rice',
  quantity: 5,
  unit: 'kg',
});
assert('rice no pack size', !('code' in riceNoPack) && !riceNoPack.packSize);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nCatalog smoke passed');
