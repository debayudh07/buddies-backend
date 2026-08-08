import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { assertFound } from '../../lib/errors';

export const notificationsRouter = Router();

notificationsRouter.get('/notifications', authenticate, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

  res.json({
    notifications,
    nextCursor: notifications.length === limit ? notifications[notifications.length - 1]?.id ?? null : null,
  });
});

notificationsRouter.get('/notifications/unread-count', authenticate, async (req, res) => {
  const count = await prisma.notification.count({
    where: { userId: req.user!.id, readAt: null },
  });
  res.json({ count });
});

notificationsRouter.post('/notifications/:id/read', authenticate, async (req, res) => {
  const id = requireParam(req, 'id');
  const existing = assertFound(
    await prisma.notification.findFirst({
      where: { id, userId: req.user!.id },
    }),
    'NOT_FOUND',
    'Notification not found',
  );
  const notification = await prisma.notification.update({
    where: { id },
    data: { readAt: existing.readAt ?? new Date() },
  });
  res.json({ notification });
});

notificationsRouter.post('/notifications/read-all', authenticate, async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
});
