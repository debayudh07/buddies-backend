import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export async function recordAdminAudit(opts: {
  actorId: string;
  action: string;
  target: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.adminAudit.create({
      data: {
        actorId: opts.actorId,
        action: opts.action,
        target: opts.target,
        meta: (opts.meta as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  } catch (err) {
    console.error('[admin-audit]', err);
  }
}
