import { PrismaClient } from '@prisma/client';
import { PRODUCT_CATEGORIES } from '../src/lib/product-categories';

const prisma = new PrismaClient();

async function main() {
  await prisma.auctionConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  });

  // Shelf-life matrix — "The buddies.docx" categorical cart
  for (const row of PRODUCT_CATEGORIES) {
    await prisma.shelfLifeMatrix.upsert({
      where: { productCategory: row.productCategory },
      create: {
        productCategory: row.productCategory,
        subCategory: row.exampleItems,
        totalShelfLifeDays: row.totalShelfLifeDays,
        minRslDays: row.minRslDays,
        notes: row.notes,
      },
      update: {
        subCategory: row.exampleItems,
        totalShelfLifeDays: row.totalShelfLifeDays,
        minRslDays: row.minRslDays,
        notes: row.notes,
      },
    });
  }

  // Return windows — same cart slugs (doc TIME WINDOW FOR RETURN, split where shelf differs)
  for (const row of PRODUCT_CATEGORIES) {
    await prisma.returnWindowMatrix.upsert({
      where: { productCategory: row.productCategory },
      create: {
        productCategory: row.productCategory,
        windowHours: row.windowHours,
        validReasons: row.validReasons,
        exampleItems: row.exampleItems,
      },
      update: {
        windowHours: row.windowHours,
        validReasons: row.validReasons,
        exampleItems: row.exampleItems,
      },
    });
  }

  // Keep legacy slugs mapped for any old claims / items (same policy as closest modern group)
  const legacyWindows = [
    {
      productCategory: 'ultra_perishables_dairy',
      windowHours: 1,
      validReasons: ['cold_chain_break', 'leakage', 'low_rsl', 'expired'],
      exampleItems: 'Legacy alias → ultra_fresh_dairy / bakery',
    },
    {
      productCategory: 'chilled_frozen_fmcg',
      windowHours: 4,
      validReasons: ['thawed', 'bloating', 'broken_seal', 'expired'],
      exampleItems: 'Legacy alias → frozen_food / chilled_cheese / chilled_fats',
    },
    {
      productCategory: 'ambient_liquids',
      windowHours: 24,
      validReasons: ['cap_damage', 'crystallization', 'low_rsl', 'leakage'],
      exampleItems: 'Legacy alias → syrups_crushes / cooking_oils',
    },
  ];
  for (const row of legacyWindows) {
    await prisma.returnWindowMatrix.upsert({
      where: { productCategory: row.productCategory },
      create: row,
      update: row,
    });
  }

  const cats = [
    { slug: 'orders', title: 'Orders & delivery', sortOrder: 1 },
    { slug: 'bidding', title: 'Bidding & Bidzone', sortOrder: 2 },
    { slug: 'payments', title: 'Offline payments', sortOrder: 3 },
    { slug: 'returns', title: 'Returns & quality', sortOrder: 4 },
    { slug: 'kyc', title: 'Supplier KYC', sortOrder: 5 },
  ];
  for (const c of cats) {
    await prisma.supportCategory.upsert({
      where: { slug: c.slug },
      create: c,
      update: c,
    });
  }

  const ordersCat = await prisma.supportCategory.findUnique({ where: { slug: 'orders' } });
  const biddingCat = await prisma.supportCategory.findUnique({ where: { slug: 'bidding' } });
  const returnsCat = await prisma.supportCategory.findUnique({ where: { slug: 'returns' } });
  const kycCat = await prisma.supportCategory.findUnique({ where: { slug: 'kyc' } });

  const articles = [
    {
      slug: 'digital-challan',
      title: 'Digital challan at doorstep',
      bodyMd:
        'Inspect for 10 minutes, then **Sign** in-app or reject on spot. Signing locks visible-damage returns. Check quantity, grade, and **Minimum RSL** from the category matrix.',
      audience: 'both' as const,
      categoryId: ordersCat?.id,
    },
    {
      slug: 'offline-payment',
      title: 'Pay after delivery (offline)',
      bodyMd:
        'After challan is signed, consumer starts offline payment (UPI/bank). Supplier confirms. Buddies does not hold goods funds.',
      audience: 'both' as const,
      categoryId: ordersCat?.id,
    },
    {
      slug: 'bidzone-rules',
      title: 'Bidzone rules for suppliers',
      bodyMd:
        'Verified KYC only. Max 5 concurrent bids (premium for more). Grade + shelf life + RSL required. RSL must meet the **category matrix minimum** for the RFQ cart categories.',
      audience: 'supplier' as const,
      categoryId: biddingCat?.id,
    },
    {
      slug: 'multi-attribute-bids',
      title: 'How bids are ranked',
      bodyMd:
        'Bids show a score from price, RSL fit vs category minimum, distance, on-time rate, and rating — not lowest price alone.',
      audience: 'consumer' as const,
      categoryId: biddingCat?.id,
    },
    {
      slug: 'return-windows',
      title: 'Return windows by category',
      bodyMd:
        'Ultra-fresh dairy/bakery & proteins **1h**, produce **2h**, chilled/frozen **4h**, ambient liquids/oils/coffee/syrups/beverages **24h**, dry staples **48h**. Media required. No change-of-mind.',
      audience: 'both' as const,
      categoryId: returnsCat?.id,
    },
    {
      slug: 'shelf-life-matrix',
      title: 'Shelf life & minimum RSL matrix',
      bodyMd:
        'Each cart category has a typical total shelf life and **Minimum RSL at delivery** (e.g. milk/curd 2d, bread 3d, proteins 1d + 12h harvest, cheese 60d, frozen 120d, dry staples 180d). Suppliers must meet or beat Min RSL for the item category.',
      audience: 'both' as const,
      categoryId: returnsCat?.id,
    },
    {
      slug: 'supplier-kyc',
      title: 'Supplier KYC checklist',
      bodyMd:
        'Business name, owner, phone, GST (optional), Aadhaar upload, shop address. Bidzone unlocks after verification.',
      audience: 'supplier' as const,
      categoryId: kycCat?.id,
    },
  ];

  for (const a of articles) {
    await prisma.supportArticle.upsert({
      where: { slug: a.slug },
      create: { ...a, published: true, sortOrder: 0 },
      update: { title: a.title, bodyMd: a.bodyMd, audience: a.audience, categoryId: a.categoryId },
    });
  }

  console.log(
    `Seed complete: ${PRODUCT_CATEGORIES.length} shelf/return categories from product doc + support articles`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
