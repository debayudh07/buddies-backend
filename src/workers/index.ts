import { prisma } from '../lib/prisma';
import { config } from '../config';
import { sendPush } from '../lib/notify';
import { logger } from '../lib/logger';

export type WorkerTickResult = { processed: number };

/** Expire open auctions past liveEndsAt. */
export async function tickAuctionExpiry(): Promise<WorkerTickResult> {
  const now = new Date();
  const expired = await prisma.bidRequest.updateMany({
    where: { status: 'open', liveEndsAt: { lt: now } },
    data: { status: 'expired' },
  });
  if (expired.count > 0) {
    await prisma.bid.updateMany({
      where: { status: 'active', bidRequest: { status: 'expired' } },
      data: { status: 'expired' },
    });
    logger.info('worker', 'expired auctions', { count: expired.count });
  }
  return { processed: expired.count };
}

/** Mark orders past slaDeadlineAt as breached + notify supplier. */
export async function tickSlaBreach(): Promise<WorkerTickResult> {
  const now = new Date();
  const late = await prisma.order.findMany({
    where: {
      slaDeadlineAt: { lt: now },
      slaStatus: { in: ['on_track', 'at_risk'] },
      status: {
        in: ['preparing', 'out_for_delivery', 'arrived', 'inspection_pending', 'bid_accepted'],
      },
    },
    take: 50,
  });
  for (const o of late) {
    await prisma.order.update({ where: { id: o.id }, data: { slaStatus: 'breached' } });
    await sendPush({
      userId: o.supplierUserId,
      title: 'SLA breached',
      body: `Order ${o.orderCode} missed same-day deadline`,
      data: { orderId: o.id },
    });
  }
  if (late.length) logger.info('worker', 'SLA breaches', { count: late.length });
  return { processed: late.length };
}

/** Notify parties when GPS stream is stale on an active session. */
export async function tickTrackingStale(): Promise<WorkerTickResult> {
  const cutoff = new Date(Date.now() - config.trackingStaleSec * 1000);
  const stale = await prisma.trackingSession.findMany({
    where: {
      active: true,
      OR: [{ lastPointAt: { lt: cutoff } }, { lastPointAt: null, startedAt: { lt: cutoff } }],
    },
    include: { order: true },
    take: 50,
  });
  for (const s of stale) {
    await sendPush({
      userId: s.order.consumerUserId,
      title: 'Tracking delayed',
      body: 'Rider location has not updated recently',
      data: { orderId: s.orderId },
    });
    await sendPush({
      userId: s.order.supplierUserId,
      title: 'Enable GPS',
      body: 'Your tracking stream looks stale',
      data: { orderId: s.orderId },
    });
  }
  if (stale.length) logger.info('worker', 'stale tracking sessions', { count: stale.length });
  return { processed: stale.length };
}

/** In-process schedulers (BullMQ optional later when Redis queues are wired). */
export function startWorkers() {
  setInterval(() => {
    void tickAuctionExpiry().catch((e) => console.error('[worker:auction]', e));
  }, 15_000);

  setInterval(() => {
    void tickSlaBreach().catch((e) => console.error('[worker:sla]', e));
  }, 30_000);

  setInterval(() => {
    void tickTrackingStale().catch((e) => console.error('[worker:tracking]', e));
  }, 60_000);

  console.log('[workers] auction expiry, SLA, tracking-stale timers started');
}
