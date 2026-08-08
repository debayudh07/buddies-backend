import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { sendPush } from '../../lib/notify';
import { responseCacheGet, responseCacheSet } from '../../lib/response-cache';

export const supportRouter = Router();

type SupportAudience = 'consumer' | 'supplier' | 'both';

function audienceForRole(role: string): SupportAudience[] {
  if (role === 'supplier') return ['supplier', 'both'];
  if (role === 'consumer') return ['consumer', 'both'];
  return ['consumer', 'supplier', 'both'];
}

supportRouter.get('/support/categories', authenticate, async (_req, res) => {
  const categories = await prisma.supportCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  res.json({ categories });
});

supportRouter.get('/support/articles', authenticate, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const audiences = audienceForRole(req.user!.role);
  const cacheKey = q
    ? null
    : `support:articles:${req.user!.role}`;
  if (cacheKey) {
    const cached = responseCacheGet<{ articles: unknown[] }>(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.json(cached);
      return;
    }
  }

  const articles = await prisma.supportArticle.findMany({
    where: {
      published: true,
      audience: { in: audiences as never },
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { bodyMd: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    // List DTO — full body only on detail / search.
    select: {
      id: true,
      slug: true,
      title: true,
      audience: true,
      sortOrder: true,
      updatedAt: true,
      createdAt: true,
      ...(q ? { bodyMd: true as const } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }],
    take: 50,
  });

  const payload = {
    articles: articles.map((a) => {
      if (!q) return a;
      const row = a as typeof a & { bodyMd?: string };
      const { bodyMd, ...rest } = row;
      return {
        ...rest,
        summary: bodyMd
          ? bodyMd.replace(/\s+/g, ' ').trim().slice(0, 160)
          : undefined,
      };
    }),
  };

  if (cacheKey) {
    responseCacheSet(cacheKey, payload, 30_000);
  }
  res.setHeader('X-Cache', 'MISS');
  res.json(payload);
});

supportRouter.get('/support/articles/:slug', authenticate, async (req, res) => {
  const article = assertFound(
    await prisma.supportArticle.findUnique({ where: { slug: requireParam(req, 'slug') } }),
  );
  if (!article.published) throw new AppError(404, 'NOT_FOUND', 'Article not found');
  const allowed = audienceForRole(req.user!.role);
  if (!allowed.includes(article.audience as SupportAudience) && req.user!.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Not available for your role');
  }
  res.json({ article });
});

supportRouter.post(
  '/support/tickets',
  authenticate,
  validateBody(
    z.object({
      category: z.string(),
      subject: z.string().min(3),
      body: z.string().min(1),
      orderId: z.string().uuid().optional(),
    }),
  ),
  async (req, res) => {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user!.id,
        role: req.user!.role,
        category: req.body.category,
        subject: req.body.subject,
        orderId: req.body.orderId,
        messages: {
          create: {
            senderId: req.user!.id,
            body: req.body.body,
            isOps: false,
          },
        },
      },
      include: { messages: true },
    });
    res.status(201).json({ ticket });
  },
);

supportRouter.get('/support/tickets', authenticate, async (req, res) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user!.id },
    orderBy: { updatedAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  res.json({ tickets });
});

supportRouter.get('/support/tickets/:id', authenticate, async (req, res) => {
  const ticket = assertFound(
    await prisma.supportTicket.findUnique({
      where: { id: requireParam(req, 'id') },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    }),
  );
  if (ticket.userId !== req.user!.id && req.user!.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Not yours');
  }
  res.json({ ticket });
});

supportRouter.post(
  '/support/tickets/:id/messages',
  authenticate,
  validateBody(z.object({ body: z.string().min(1), attachmentRef: z.string().optional() })),
  async (req, res) => {
    const ticket = assertFound(await prisma.supportTicket.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (ticket.userId !== req.user!.id && req.user!.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Not yours');
    }
    const message = await prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        senderId: req.user!.id,
        body: req.body.body,
        attachmentRef: req.body.attachmentRef,
        isOps: req.user!.role === 'admin',
      },
    });
    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: req.user!.role === 'admin' ? 'pending_user' : 'pending_ops' },
    });
    if (req.user!.role === 'admin') {
      await sendPush({
        userId: ticket.userId,
        title: 'Support replied',
        body: req.body.body.slice(0, 80),
        data: { ticketId: ticket.id },
      });
    }
    res.status(201).json({ message });
  },
);

supportRouter.post(
  '/admin/support/articles',
  authenticate,
  requireRole('admin'),
  validateBody(
    z.object({
      slug: z.string(),
      title: z.string(),
      bodyMd: z.string(),
      audience: z.enum(['consumer', 'supplier', 'both']),
      categoryId: z.string().uuid().optional(),
      sortOrder: z.number().int().optional(),
      published: z.boolean().optional(),
    }),
  ),
  async (req, res) => {
    const article = await prisma.supportArticle.create({
      data: {
        ...req.body,
        audience: req.body.audience as never,
      },
    });
    res.status(201).json({ article });
  },
);

supportRouter.patch(
  '/admin/support/articles/:id',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    const article = await prisma.supportArticle.update({
      where: { id: requireParam(req, 'id') },
      data: req.body,
    });
    res.json({ article });
  },
);
