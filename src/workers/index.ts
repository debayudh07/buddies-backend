import { prisma } from '../lib/prisma';
import { config } from '../config';
import { sendPush } from '../lib/notify';
import { logger } from '../lib/logger';
import { expireSubscriptions } from '../modules/subscriptions/service';
import { emitAuction, emitBidzone, emitUser } from '../lib/realtime';

export type WorkerTickResult = { processed: number };

/** Expire open auctions past liveEndsAt, and active bids past their expiresAt (bid TTL). */
export async function tickAuctionExpiry(): Promise<WorkerTickResult> {
  const now = new Date();
  let processed = 0;

  const expiring = await prisma.bidRequest.findMany({
    where: { status: 'open', liveEndsAt: { lt: now } },
    select: { id: true, consumer: { select: { userId: true } } },
    take: 100,
  });
  if (expiring.length > 0) {
    const ids = expiring.map((r) => r.id);
    await prisma.bidRequest.updateMany({
      where: { id: { in: ids } },
      data: { status: 'expired' },
    });
    await prisma.bid.updateMany({
      where: { status: 'active', bidRequestId: { in: ids } },
      data: { status: 'expired' },
    });
    for (const r of expiring) {
      emitAuction(r.id, 'auction.expired', { bidRequestId: r.id, status: 'expired' });
      emitBidzone('all', 'demand.request_closed', { id: r.id, status: 'expired' });
      emitUser(r.consumer.userId, 'bidRequest.updated', { id: r.id, status: 'expired' });
    }
    logger.info('worker', 'expired auctions', { count: expiring.length });
    processed += expiring.length;
  }

  // Per-bid TTL (default 5 minutes) — free quota and hide stale offers.
  // Requests expired above already closed their bids, so this is TTL-only.
  const staleBids = await prisma.bid.findMany({
    where: {
      status: 'active',
      expiresAt: { lt: now },
    },
    select: {
      id: true,
      bidRequestId: true,
      supplier: { select: { userId: true } },
    },
    take: 200,
  });
  if (staleBids.length > 0) {
    await prisma.bid.updateMany({
      where: { id: { in: staleBids.map((b) => b.id) } },
      data: { status: 'expired' },
    });
    for (const b of staleBids) {
      emitAuction(b.bidRequestId, 'auction.bid_expired', { bidId: b.id });
      emitUser(b.supplier.userId, 'bid.status_changed', {
        bidId: b.id,
        status: 'expired',
        bidRequestId: b.bidRequestId,
      });
    }
    logger.info('worker', 'expired bids by TTL', { count: staleBids.length });
    processed += staleBids.length;
  }

  return { processed };
}

/** Deactivate subscriptions past endsAt so premium bid caps do not stick. */
export async function tickSubscriptionExpiry(): Promise<WorkerTickResult> {
  const count = await expireSubscriptions();
  if (count) logger.info('worker', 'expired subscriptions', { count });
  return { processed: count };
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
      data: { orderId: o.id, type: 'order' },
    });
  }
  if (late.length) logger.info('worker', 'SLA breaches', { count: late.length });
  return { processed: late.length };
}

/** Notify parties when GPS stream is stale on an active session (at most once per session episode). */
const staleTrackingNotified = new Set<string>();

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

  // Drop notify-state for sessions that are active again or no longer listed.
  const stillStale = new Set(stale.map((s) => s.orderId));
  for (const id of [...staleTrackingNotified]) {
    if (!stillStale.has(id)) staleTrackingNotified.delete(id);
  }

  let notified = 0;
  for (const s of stale) {
    if (staleTrackingNotified.has(s.orderId)) continue;
    staleTrackingNotified.add(s.orderId);
    notified += 1;
    void sendPush({
      userId: s.order.consumerUserId,
      title: 'Tracking delayed',
      body: 'Rider location has not updated recently',
      data: { orderId: s.orderId, type: 'order' },
    }).catch(() => undefined);
    void sendPush({
      userId: s.order.supplierUserId,
      title: 'Enable GPS',
      body: 'Your tracking stream looks stale',
      data: { orderId: s.orderId, type: 'order' },
    }).catch(() => undefined);
  }
  if (notified) logger.info('worker', 'stale tracking sessions', { count: notified });
  return { processed: notified };
}

/**
 * True when now falls inside `config.keepAlive.activeHours` ("HH-HH", server
 * local time). An empty setting means always. A window that wraps midnight
 * (e.g. "22-6") is supported.
 */
export function isWithinKeepAliveWindow(window: string, now = new Date()): boolean {
  const trimmed = window.trim();
  if (!trimmed) return true;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(trimmed);
  if (!m) return true; // Unparseable window must not silently disable the ping.
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) return true;
  const hour = now.getHours();
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Keep the instance warm by requesting our own public /healthz.
 *
 * Only prevents an idle spin-down; it cannot wake a process that is already
 * stopped. Skipped silently when no public URL is known, so local dev and CI
 * never emit outbound requests.
 */
export async function tickKeepAlive(): Promise<WorkerTickResult> {
  const { url, activeHours } = config.keepAlive;
  if (!url) return { processed: 0 };
  if (!isWithinKeepAliveWindow(activeHours)) return { processed: 0 };

  try {
    const res = await fetch(`${url}/healthz`, {
      method: 'GET',
      headers: { 'user-agent': 'buddies-keepalive' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn('worker', 'keepalive non-ok', { status: res.status });
      return { processed: 0 };
    }
    return { processed: 1 };
  } catch (e) {
    // A failed ping is not actionable — log quietly and try again next tick.
    logger.warn('worker', 'keepalive failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { processed: 0 };
  }
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

  setInterval(() => {
    void tickSubscriptionExpiry().catch((e) => console.error('[worker:subs]', e));
  }, 60_000);

  const keepAlive = config.keepAlive;
  if (keepAlive.enabled && keepAlive.url) {
    // Fire once at boot so the warm window starts immediately after a deploy.
    void tickKeepAlive().catch(() => undefined);
    setInterval(
      () => {
        void tickKeepAlive().catch((e) => console.error('[worker:keepalive]', e));
      },
      Math.max(60, keepAlive.intervalSec) * 1000,
    ).unref();
    logger.info('boot', 'keepalive enabled', {
      target: `${keepAlive.url}/healthz`,
      everySec: keepAlive.intervalSec,
      activeHours: keepAlive.activeHours || 'always',
    });
  } else if (keepAlive.enabled) {
    logger.warn(
      'boot',
      'keepalive enabled but no URL — set KEEPALIVE_URL (or deploy where RENDER_EXTERNAL_URL exists)',
    );
  }

  console.log('[workers] auction, SLA, tracking-stale, subscription-expiry timers started');
}
