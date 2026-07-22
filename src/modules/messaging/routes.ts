import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { emitChat } from '../../socket';
import { sendPush } from '../../lib/notify';

export const messagingRouter = Router();

async function assertOrderMember(orderId: string, userId: string) {
  const order = assertFound(await prisma.order.findUnique({ where: { id: orderId }, include: { chatThread: true } }));
  if (order.consumerUserId !== userId && order.supplierUserId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'Not a party to this order');
  }
  return order;
}

messagingRouter.get('/orders/:id/chat', authenticate, async (req, res) => {
  const order = await assertOrderMember(requireParam(req, 'id'), req.user!.id);
  if (!order.chatThread) throw new AppError(404, 'NO_THREAD', 'Chat opens after dual ack');
  const messages = await prisma.chatMessage.findMany({
    where: { threadId: order.chatThread.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ thread: order.chatThread, messages });
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
    await sendPush({
      userId: peer,
      title: 'New message',
      body: req.body.body.slice(0, 80),
      data: { orderId: order.id, threadId: order.chatThread.id },
    });

    res.status(201).json({ message });
  },
);
