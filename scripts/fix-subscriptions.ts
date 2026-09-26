/**
 * One-off cleanup for subscriptions created before POST /subscriptions was made
 * idempotent. Old code switched the running plan off on every tap but left its
 * endsAt in the future, so history shows overlapping months.
 *
 * For each user, walking rows oldest → newest:
 *  - an inactive row whose endsAt is later than the next row's startsAt is
 *    trimmed so it ends when the next one started ("replaced")
 *  - only the newest row still inside its month stays active
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/fix-subscriptions.ts
 *   npx tsx scripts/fix-subscriptions.ts --apply
 */
import { prisma } from '../src/lib/prisma';

async function main() {
  const apply = process.argv.includes('--apply');
  const now = new Date();
  const rows = await prisma.subscription.findMany({
    orderBy: [{ userId: 'asc' }, { startsAt: 'asc' }, { createdAt: 'asc' }],
  });

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }

  const updates: { id: string; data: { active?: boolean; endsAt?: Date } }[] = [];

  for (const list of byUser.values()) {
    const live = [...list].reverse().find((s) => s.active && (!s.endsAt || s.endsAt > now));
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const next = list[i + 1];
      const data: { active?: boolean; endsAt?: Date } = {};
      if (s !== live && s.active) data.active = false;
      if (s !== live && next && s.endsAt && s.endsAt > next.startsAt) data.endsAt = next.startsAt;
      if (Object.keys(data).length) updates.push({ id: s.id, data });
    }
  }

  console.log(`${rows.length} subscriptions, ${byUser.size} users, ${updates.length} to fix`);
  for (const u of updates.slice(0, 20)) console.log(' ', u.id, JSON.stringify(u.data));
  if (updates.length > 20) console.log(`  … and ${updates.length - 20} more`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to write these changes.');
    return;
  }
  await prisma.$transaction(
    updates.map((u) => prisma.subscription.update({ where: { id: u.id }, data: u.data })),
  );
  console.log(`Applied ${updates.length} updates.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
