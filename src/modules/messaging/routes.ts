import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { emitChat } from '../../socket';
import { sendPush } from '../../lib/notify';
import { parseLimit } from '../../lib/pagination';

export const messagingRouter = Router();

async function assertOrderMember(orderId: string, userId: string) {
  const order = assertFound(
    await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        consumerUserId: true,
        supplierUserId: true,
        chatThread: true,
      },
    }),
  );
  if (order.consumerUserId !== userId && order.supplierUserId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not a party to this order');
  }
  return order;
}

messagingRouter.get('/orders/:id/chat', authenticate, async (req, res) => {
  const orderId = requireParam(req, 'id');
  const take = parseLimit(req.query.limit, { defaultLimit: 100, max: 200 });

  // One query: thread by orderId + recent messages (saves a serial Prisma RTT).
  const thread = await prisma.chatThread.findUnique({
    where: { orderId },
    select: {
      id: true,
      orderId: true,
      consumerUserId: true,
      supplierUserId: true,
      createdAt: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          threadId: true,
          senderId: true,
          body: true,
          imageRef: true,
          createdAt: true,
        },
      },
    },
  });
  if (!thread) throw new AppError(404, 'NO_THREAD', 'Chat opens after the consumer accepts a bid');
  if (
    thread.consumerUserId !== req.user!.id &&
    thread.supplierUserId !== req.user!.id
  ) {
    throw new AppError(403, 'FORBIDDEN', 'Not a party to this order');
  }

  const { messages: recent, ...threadMeta } = thread;
  const messages = [...recent].reverse();
  res.json({ thread: threadMeta, threadId: threadMeta.id, messages });
});

messagingRouter.post(
  '/orders/:id/chat/messages',
  authenticate,
  validateBody(z.object({ body: z.string().min(1), imageRef: z.string().optional() })),
  async (req, res) => {
    const order = await assertOrderMember(requireParam(req, 'id'), req.user!.id);
    if (!order.chatThread) throw new AppError(404, 'NO_THREAD', 'No chat thread');

    const message = await prisma.chatMessage.create({
      data: {
        threadId: order.chatThread.id,
        senderId: req.user!.id,
        body: req.body.body,
        imageRef: req.body.imageRef,
      },
    });

    emitChat(order.chatThread.id, 'chat.message_created', { message });

    const peer =
      order.consumerUserId === req.user!.id ? order.supplierUserId : order.consumerUserId;
    // Don't hold the HTTP response for FCM.
    void sendPush({
      userId: peer,
      title: 'New message',
      body: req.body.body.slice(0, 80),
      data: { orderId: order.id, threadId: order.chatThread.id },
    }).catch(() => undefined);

    res.status(201).json({ message });
  },
);

/** Peer typing indicator (broadcast only — not persisted). */
messagingRouter.post(
  '/orders/:id/chat/typing',
  authenticate,
  validateBody(z.object({ typing: z.boolean() })),
  async (req, res) => {
    const order = await assertOrderMember(requireParam(req, 'id'), req.user!.id);
    if (!order.chatThread) throw new AppError(404, 'NO_THREAD', 'No chat thread');
    emitChat(order.chatThread.id, 'chat.typing', {
      typing: req.body.typing === true,
      userId: req.user!.id,
      orderId: order.id,
    });
    res.json({ ok: true });
  },
);
