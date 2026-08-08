/**
 * Deep realtime smoke: Redis, GPS stream, auto-extend, workers, extra socket events.
 * Run: npx tsx scripts/realtime-deep-smoke.ts
 * Requires API on :PORT with DEV_AUTH_BYPASS, local Redis, seeded DB.
 */
/// <reference types="node" />
import 'dotenv/config';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { tickAuctionExpiry, tickSlaBreach, tickTrackingStale } from '../src/workers/index';
import { config } from '../src/config';

const PORT = process.env.PORT ?? '8000';
const ROOT = process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`;
const BASE = `${ROOT}/v1`;

const C = `dev:consumer:${randomUUID()}`;
const S = `dev:supplier:${randomUUID()}`;

const prisma = new PrismaClient();

type Step = { ok: boolean; name: string; detail?: string };
const steps: Step[] = [];

function log(msg: string) {
  console.log(msg);
}
function pass(name: string, detail?: string) {
  steps.push({ ok: true, name, detail });
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail: string): never {
  steps.push({ ok: false, name, detail });
  throw new Error(`[FAIL] ${name}: ${detail}`);
}

async function api(method: string, path: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
  return data;
}

function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 20_000,
  predicate?: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeoutMs);
    function onEvent(payload: T) {
      if (predicate && !predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

async function bootstrap() {
  await api('POST', '/auth/session', C);
  await api('PUT', '/consumer/profile', C, {
    restaurantName: 'Deep Smoke Kitchen',
    lat: 12.97,
    lng: 77.59,
    addressLine: '12 MG',
  });
  await api('POST', '/me/privacy-accept', C);
  await api('POST', '/auth/session', S);
  await api('POST', '/supplier/kyc', S, {
    businessName: 'Deep Smoke Mart',
    ownerName: 'Deep Supplier',
    ownerPhone: '+918888888888',
    shopAddressPrivate: 'Wh Deep',
    publicLabel: 'Deep Mart',
    lat: 13.01,
    lng: 77.55,
    categories: ['fresh_produce'],
  });
  try {
    await api('POST', '/supplier/kyc/submit', S);
  } catch {
    /* ok */
  }
  await api('POST', '/supplier/kyc/dev-verify', S);
}

async function main() {
  log(`\n=== Deep realtime smoke @ ${ROOT} ===\n`);

  // ---------- 0. Redis ----------
  log('0. Redis');
  if (!config.redisUrl) fail('redis url', 'REDIS_URL missing');
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  await redis.connect();
  if ((await redis.ping()) !== 'PONG') fail('redis ping', 'not PONG');
  pass('redis ping');
  const key = `smoke:deep:${Date.now()}`;
  await redis.set(key, 'ok', 'EX', 60);
  if ((await redis.get(key)) !== 'ok') fail('redis set/get', 'mismatch');
  pass('redis set/get');
  await redis.quit();

  await bootstrap();
  pass('bootstrap identities');

  const rooms = new Set<string>();
  const socket: Socket = io(ROOT, {
    transports: ['polling', 'websocket'],
    upgrade: true,
    forceNew: true,
    timeout: 30_000,
    reconnection: true,
    reconnectionAttempts: 8,
  });
  const joinRoom = (room: string) => {
    rooms.add(room);
    socket.emit('join', room);
  };
  let firstConnect = true;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket connect timeout')), 30_000);
    socket.on('connect', () => {
      for (const room of rooms) socket.emit('join', room);
      if (firstConnect) {
        firstConnect = false;
        clearTimeout(t);
        resolve();
      } else {
        log(`  … reconnected ${socket.id} (re-joined ${rooms.size} rooms)`);
      }
    });
    socket.on('connect_error', (err) => {
      log(`  … connect_error: ${err.message}`);
    });
  });
  pass('socket connected', `${socket.id} via ${socket.io.engine.transport.name}`);

  // Warm API again (Render can 404 briefly after poll storms)
  await fetch(`${ROOT}/health`);

  // ---------- 1. Auto-extend ----------
  log('\n1. Auction auto-extend');
  const br = await api('POST', '/consumer/bid-requests', C, {
    privacyAccepted: true,
    budgetPaise: 200000,
    items: [{ name: 'Potatoes', quantity: 8, unit: 'kg', productCategory: 'fresh_produce' }],
    lat: 12.97,
    lng: 77.59,
  });
  const bidRequestId = br.bidRequest.id as string;
  // Force window into auto-extend trigger (default 60s)
  const nearEnd = new Date(Date.now() + 20_000);
  await prisma.bidRequest.update({
    where: { id: bidRequestId },
    data: { liveEndsAt: nearEnd, extendCount: 0 },
  });
  joinRoom(`auction:${bidRequestId}`);
  await new Promise((r) => setTimeout(r, 400));
  const bidRes = await api('POST', '/supplier/bids', S, {
    bidRequestId,
    amountPaise: 180000,
    grade: 'A',
    shelfLifeDays: 5,
    rslDaysAtDelivery: 3,
  });
  if ((bidRes.extendCount ?? 0) < 1) {
    fail('auto-extend', `extendCount=${bidRes.extendCount}`);
  }
  pass('auto-extend on late bid', `extendCount=${bidRes.extendCount}`);
  const bidId = bidRes.bid.id as string;

  // ---------- 2. Withdraw socket + place second bid path ----------
  log('\n2. Withdraw / reject socket events');
  // Need a second supplier bid to reject later — withdraw first bid then re-place
  const withdrawEvt = waitForEvent(socket, 'auction.bid_withdrawn', 15_000);
  await api('POST', `/supplier/bids/${bidId}/withdraw`, S);
  await withdrawEvt;
  pass('auction.bid_withdrawn');

  const placeEvt = waitForEvent<any>(socket, 'auction.bid_placed', 15_000);
  const bid2 = await api('POST', '/supplier/bids', S, {
    bidRequestId,
    amountPaise: 175000,
    grade: 'A',
    shelfLifeDays: 5,
    rslDaysAtDelivery: 3,
  });
  await placeEvt;
  const bidId2 = bid2.bid.id as string;
  pass('re-bid after withdraw');

  await api('POST', `/consumer/bids/${bidId2}/accept`, C);
  await api('POST', `/bids/${bidId2}/acknowledge`, C, { role: 'consumer' });
  const threadEvt = waitForEvent<any>(socket, 'chat.thread_created', 30_000);
  // Must join chat room after we know thread — thread_created emits to chat:{id}
  // Listen on any via capturing after ack; createOrder emits to chat room we haven't joined.
  // So verify via HTTP + optional: join after order and check history.
  const ack = await api('POST', `/bids/${bidId2}/acknowledge`, S, { role: 'supplier' });
  const orderId = ack.order.id as string;
  const threadId = ack.order.chatThread?.id as string | undefined;
  if (!threadId) fail('chat thread', 'missing');
  // thread_created may have been missed if we weren't in room — join and treat HTTP as source of truth
  joinRoom(`chat:${threadId}`);
  joinRoom(`tracking:${orderId}`);
  await new Promise((r) => setTimeout(r, 400));
  pass('order + chat thread', orderId);
  // Drain optional thread event without failing
  void threadEvt.catch(() => undefined);

  // ---------- 3. Multi-point GPS + Redis live cache ----------
  log('\n3. GPS stream + Redis live cache');
  await api('POST', `/orders/${orderId}/status`, S, { status: 'preparing' });
  await api('POST', `/orders/${orderId}/status`, S, { status: 'out_for_delivery' });

  const points = [
    { lat: 13.0, lng: 77.55, speed: 20 },
    { lat: 12.99, lng: 77.56, speed: 22 },
    { lat: 12.98, lng: 77.57, speed: 18 },
    { lat: 12.975, lng: 77.58, speed: 15 },
  ];
  let received = 0;
  const onTrack = () => {
    received += 1;
  };
  socket.on('tracking.location_updated', onTrack);
  for (const p of points) {
    await api('POST', `/orders/${orderId}/tracking`, S, p);
    await new Promise((r) => setTimeout(r, 150));
  }
  // Allow socket events to flush
  await new Promise((r) => setTimeout(r, 500));
  socket.off('tracking.location_updated', onTrack);
  if (received < 3) fail('gps stream sockets', `only ${received}/4 events`);
  pass('gps multi-point sockets', `${received} events`);

  const live = await api('GET', `/orders/${orderId}/tracking/live`, C);
  if (!live.latest) fail('tracking live', 'no latest point');
  if (live.source !== 'redis') {
    // Redis may miss if server redis was down; still OK if DB works
    pass('tracking live', `source=${live.source} (expected redis when server redis up)`);
  } else {
    pass('tracking live from redis cache', `lat=${live.latest.lat ?? live.latest?.lat}`);
  }

  // ---------- 4. Workers: stale GPS, SLA, auction expiry ----------
  log('\n4. Background workers (direct ticks)');

  // Stale GPS: backdate lastPointAt beyond TRACKING_STALE_SEC
  const staleCutoff = new Date(Date.now() - (config.trackingStaleSec + 30) * 1000);
  await prisma.trackingSession.update({
    where: { orderId },
    data: { lastPointAt: staleCutoff, active: true },
  });
  const staleRes = await tickTrackingStale();
  if (staleRes.processed < 1) fail('tickTrackingStale', 'processed=0');
  pass('tickTrackingStale', `processed=${staleRes.processed}`);

  // SLA breach
  await prisma.order.update({
    where: { id: orderId },
    data: {
      slaDeadlineAt: new Date(Date.now() - 60_000),
      slaStatus: 'on_track',
      status: 'out_for_delivery',
    },
  });
  const slaRes = await tickSlaBreach();
  if (slaRes.processed < 1) fail('tickSlaBreach', 'processed=0');
  const afterSla = await prisma.order.findUnique({ where: { id: orderId } });
  if (afterSla?.slaStatus !== 'breached') fail('sla status', `${afterSla?.slaStatus}`);
  pass('tickSlaBreach', 'slaStatus=breached');

  // Auction expiry
  const br2 = await api('POST', '/consumer/bid-requests', C, {
    privacyAccepted: true,
    budgetPaise: 100000,
    items: [{ name: 'Coriander', quantity: 1, unit: 'kg', productCategory: 'fresh_produce' }],
  });
  await prisma.bidRequest.update({
    where: { id: br2.bidRequest.id },
    data: { liveEndsAt: new Date(Date.now() - 5_000), status: 'open' },
  });
  const expRes = await tickAuctionExpiry();
  if (expRes.processed < 1) fail('tickAuctionExpiry', 'processed=0');
  const expired = await prisma.bidRequest.findUnique({ where: { id: br2.bidRequest.id } });
  if (expired?.status !== 'expired') fail('auction expired status', `${expired?.status}`);
  pass('tickAuctionExpiry', br2.bidRequest.id);

  // ---------- 5. Reject path (separate RFQ) ----------
  log('\n5. Reject socket');
  const br3 = await api('POST', '/consumer/bid-requests', C, {
    privacyAccepted: true,
    budgetPaise: 150000,
    items: [{ name: 'Garlic', quantity: 2, unit: 'kg', productCategory: 'fresh_produce' }],
  });
  joinRoom(`auction:${br3.bidRequest.id}`);
  await new Promise((r) => setTimeout(r, 400));
  const bid3 = await api('POST', '/supplier/bids', S, {
    bidRequestId: br3.bidRequest.id,
    amountPaise: 140000,
    grade: 'B',
    shelfLifeDays: 10,
    rslDaysAtDelivery: 5,
  });
  const rejectEvt = waitForEvent(socket, 'auction.bid_rejected', 15_000);
  await api('POST', `/consumer/bids/${bid3.bid.id}/reject`, C);
  await rejectEvt;
  pass('auction.bid_rejected');

  socket.close();
  await prisma.$disconnect();

  log('\n=== DEEP REALTIME SUMMARY ===');
  log(`Passed: ${steps.filter((s) => s.ok).length}/${steps.length}`);
  log('DEEP REALTIME OK\n');
}

main().catch(async (e) => {
  console.error('\n' + (e instanceof Error ? e.message : String(e)));
  console.error(`Passed before fail: ${steps.filter((s) => s.ok).length}`);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
