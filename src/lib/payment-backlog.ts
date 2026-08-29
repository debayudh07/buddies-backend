import { prisma } from './prisma';
import { AppError } from './errors';

export const PAYMENT_BACKLOG_CAP = 3;

export const PAYMENT_BACKLOG_MESSAGE =
  `Settle payment on existing orders first. You can have at most ${PAYMENT_BACKLOG_CAP} orders with payment started but not marked paid.`;

export async function countPaymentBacklog(consumerUserId: string): Promise<number> {
  return prisma.order.count({
    where: {
      consumerUserId,
      status: { notIn: ['rejected_on_spot', 'closed'] },
      offlinePayment: {
        status: { in: ['initiated', 'disputed'] },
      },
    },
  });
}

export async function getPaymentBacklog(consumerUserId: string) {
  const pending = await countPaymentBacklog(consumerUserId);
  return {
    pending,
    cap: PAYMENT_BACKLOG_CAP,
    blocked: pending >= PAYMENT_BACKLOG_CAP,
  };
}

export async function assertPaymentBacklog(
  consumerUserId: string,
  additionalOrders = 0,
) {
  const pending = await countPaymentBacklog(consumerUserId);
  if (pending >= PAYMENT_BACKLOG_CAP || pending + additionalOrders > PAYMENT_BACKLOG_CAP) {
    throw new AppError(403, 'PAYMENT_BACKLOG', PAYMENT_BACKLOG_MESSAGE);
  }
}
