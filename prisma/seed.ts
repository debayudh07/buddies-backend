import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.auctionConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default' },
    update: {},
  });

  const shelf = [
    { productCategory: 'ultra_perishables_dairy', totalShelfLifeDays: 5, minRslDays: 2, notes: 'Milk, curd, paneer, bread' },
    { productCategory: 'fresh_proteins', totalShelfLifeDays: 3, minRslDays: 1, notes: 'Chicken, fish — deliver within 12h of harvest preferred' },
    { productCategory: 'fresh_produce', totalShelfLifeDays: 5, minRslDays: 2, notes: 'Leafy greens, tomatoes' },
    { productCategory: 'chilled_frozen_fmcg', totalShelfLifeDays: 180, minRslDays: 60, notes: 'Cheese, butter, frozen fries' },
    { productCategory: 'ambient_liquids', totalShelfLifeDays: 365, minRslDays: 60, notes: 'Oils, syrups' },
    { productCategory: 'dry_staples', totalShelfLifeDays: 540, minRslDays: 180, notes: 'Flour, rice, sugar, spices' },
  ];
  for (const row of shelf) {
    await prisma.shelfLifeMatrix.upsert({
      where: { productCategory: row.productCategory },
      create: row,
      update: row,
    });
  }

  const windows = [
    { productCategory: 'ultra_perishables_dairy', windowHours: 1, validReasons: ['cold_chain_break', 'leakage', 'low_rsl'], exampleItems: 'Milk, curd, paneer, bread' },
    { productCategory: 'fresh_proteins', windowHours: 1, validReasons: ['discoloration', 'off_odor', 'temp_abuse'], exampleItems: 'Chicken, fish' },
    { productCategory: 'fresh_produce', windowHours: 2, validReasons: ['rotting', 'bruising', 'wrong_weight'], exampleItems: 'Greens, tomatoes' },
    { productCategory: 'chilled_frozen_fmcg', windowHours: 4, validReasons: ['thawed', 'bloating', 'broken_seal'], exampleItems: 'Cheese, frozen fries' },
    { productCategory: 'ambient_liquids', windowHours: 24, validReasons: ['cap_damage', 'crystallization', 'low_rsl'], exampleItems: 'Oils, syrups' },
    { productCategory: 'dry_staples', windowHours: 48, validReasons: ['moisture', 'torn_pack', 'pest'], exampleItems: 'Rice, flour, spices' },
  ];
  for (const row of windows) {
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
      bodyMd: 'Inspect for 10 minutes, then **Sign** in-app or reject on spot. Signing locks visible-damage returns.',
      audience: 'both' as const,
      categoryId: ordersCat?.id,
    },
    {
      slug: 'offline-payment',
      title: 'Pay after delivery (offline)',
      bodyMd: 'After challan is signed, consumer starts offline payment (UPI/bank). Supplier confirms. Buddies does not hold goods funds.',
      audience: 'both' as const,
      categoryId: ordersCat?.id,
    },
    {
      slug: 'bidzone-rules',
      title: 'Bidzone rules for suppliers',
      bodyMd: 'Verified KYC only. Max 5 concurrent bids (premium for more). Grade + RSL required. Min decrement + auto-extend apply.',
      audience: 'supplier' as const,
      categoryId: biddingCat?.id,
    },
    {
      slug: 'multi-attribute-bids',
      title: 'How bids are ranked',
      bodyMd: 'Bids show a score from price, RSL fit, distance, on-time rate, and rating — not lowest price alone.',
      audience: 'consumer' as const,
      categoryId: biddingCat?.id,
    },
    {
      slug: 'return-windows',
      title: 'Return windows by category',
      bodyMd: 'Ultra-perishables 1h, proteins 1h, produce 2h, chilled/frozen 4h, ambient liquids 24h, dry staples 48h. Media required. No change-of-mind.',
      audience: 'both' as const,
      categoryId: returnsCat?.id,
    },
    {
      slug: 'supplier-kyc',
      title: 'Supplier KYC checklist',
      bodyMd: 'Business name, owner, phone, GST (optional), Aadhaar upload, shop address. Bidzone unlocks after verification.',
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

  console.log('Seed complete: auction config, shelf/return matrices, support articles');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
