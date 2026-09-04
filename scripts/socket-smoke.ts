/**
 * Socket.IO live-event smoke.
 * Run: npx tsx scripts/socket-smoke.ts
 * Requires API on PORT (default 8000) with DEV_AUTH_BYPASS=true.
 */
/// <reference types="node" />
import 'dotenv/config';
import process from 'node:process';
import { io, type Socket } from 'socket.io-client';

const PORT = process.env.PORT ?? '8000';
const ROOT = process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`;
const BASE = `${ROOT}/v1`;

const C = 'dev:consumer:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S = 'dev:supplier:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = 'dev:admin:cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
  }
  return data;
}

function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 12_000,
  predicate?: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timeout waiting for "${event}" (${timeoutMs}ms)`));
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

async function main() {
  log(`\n=== Socket.IO smoke @ ${ROOT} ===\n`);

  const rooms = new Set<string>();
  const socket: Socket = io(ROOT, {
    // Render free tier: allow polling fallback if pure websocket fails
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
      // Re-join rooms after Render idle disconnects / reconnects
      for (const room of rooms) socket.emit('join', room);
      if (firstConnect) {
        firstConnect = false;
        clearTimeout(t);
        pass('socket connected', `${socket.id} via ${socket.io.engine.transport.name}`);
        resolve();
      } else {
        log(`  … reconnected ${socket.id} (re-joined ${rooms.size} rooms)`);
      }
    });
    socket.on('connect_error', (err) => {
      log(`  … connect_error: ${err.message}`);
    });
  });

  joinRoom('bidzone:all');
  pass('joined bidzone:all');

  // Bootstrap identities + KYC (may take a while on Render — keep socket alive via reconnect handlers)
  log('\n1. Bootstrap');
  await api('POST', '/auth/session', C);
  await api('PUT', '/consumer/profile', C, {
    restaurantName: 'Socket Kitchen',
    lat: 12.97,
    lng: 77.59,
  });
  await api('POST', '/me/privacy-accept', C);
  await api('POST', '/auth/session', S);
  await api('POST', '/supplier/kyc', S, {
    businessName: 'Socket Mart',
    ownerName: 'Socket Supplier',
    ownerPhone: '+919999999999',
    shopAddressPrivate: 'Wh 1',
    publicLabel: 'Socket Mart',
    lat: 13.0,
    lng: 77.5,
    categories: ['vegetables'],
  });
  try {
    await api('POST', '/supplier/kyc/submit', S);
  } catch {
    /* already submitted */
  }
  try {
    await api('POST', '/supplier/kyc/dev-verify', S);
  } catch {
    await api('POST', `/admin/supplier/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/verify`, A);
  }
  pass('consumer + verified supplier ready');

  // Demand → expect bidzone event (re-join in case of reconnect during bootstrap)
  log('\n2. Demand + bidzone event');
  joinRoom('bidzone:all');
  await new Promise((r) => setTimeout(r, 500));
  const demandEvt = waitForEvent<any>(socket, 'demand.request_created', 45_000);
  const br = await api('POST', '/consumer/bid-requests', C, {
    privacyAccepted: true,
    budgetPaise: 300000,
    items: [{ name: 'Onions', quantity: 5, unit: 'kg', productCategory: 'vegetables' }],
    lat: 12.97,
    lng: 77.59,
  });
  const bidRequestId = br.bidRequest?.id ?? br.id;
  const demandPayload = await demandEvt;
  if (demandPayload?.id !== bidRequestId) {
    fail('demand.request_created', `id mismatch got=${demandPayload?.id}`);
  }
  pass('demand.request_created', bidRequestId);

  joinRoom(`auction:${bidRequestId}`);
  await new Promise((r) => setTimeout(r, 300));
  pass('joined auction room');

  // Bid → expect auction.bid_placed
  log('\n3. Bid + auction events');
  const bidEvt = waitForEvent<any>(socket, 'auction.bid_placed', 45_000);
  const bidRes = await api('POST', '/supplier/bids', S, {
    bidRequestId,
    amountPaise: 280000,
    grade: 'A',
    shelfLifeDays: 4,
    rslDaysAtDelivery: 2,
  });
  const bidId = bidRes.bid?.id ?? bidRes.id;
  const bidPayload = await bidEvt;
  if (bidPayload?.bid?.id !== bidId && bidPayload?.bidId !== bidId) {
    // payload shape: { bid, liveEndsAt }
    if (bidPayload?.bid?.id !== bidId) {
      fail('auction.bid_placed', `unexpected payload ${JSON.stringify(bidPayload).slice(0, 200)}`);
    }
  }
  pass('auction.bid_placed', bidId);

  const orderEvt = waitForEvent<any>(socket, 'order.created', 60_000);
  const acceptRes = await api('POST', `/consumer/bids/${bidId}/accept`, C);
  await acceptEvt;
  pass('auction.bid_accepted');

  const orderPayload = await orderEvt;
  // Optional ack timestamps only — order already exists on accept.
  await api('POST', `/bids/${bidId}/acknowledge`, C, { role: 'consumer' });
  const ack = await api('POST', `/bids/${bidId}/acknowledge`, S, { role: 'supplier' });
  const orderId = acceptRes.order?.id ?? acceptRes.orderId ?? ack.order?.id ?? orderPayload?.orderId;
  if (!orderId) fail('order.created', 'missing order id');
  if (orderPayload?.orderId && orderPayload.orderId !== orderId) {
    fail('order.created', `payload orderId mismatch ${orderPayload.orderId} vs ${orderId}`);
  }
  pass('order.created', orderId);

  // Prefer order detail for chat thread (accept payload may omit nested include)
  let threadId = acceptRes.order?.chatThread?.id ?? ack.order?.chatThread?.id;
  if (!threadId) {
    const orderDetail = await api('GET', `/orders/${orderId}`, S);
    threadId = orderDetail.order?.chatThread?.id ?? orderDetail.chatThread?.id;
  }
  if (!threadId) fail('chat thread', 'missing after accept');
  joinRoom(`tracking:${orderId}`);
  joinRoom(`chat:${threadId}`);
  await new Promise((r) => setTimeout(r, 300));
  pass('joined tracking + chat rooms');

  // Status / tracking / chat
  log('\n4. Tracking + chat events');
  await api('POST', `/orders/${orderId}/status`, S, { status: 'preparing' });

  const statusEvt = waitForEvent<any>(
    socket,
    'order.status_changed',
    45_000,
    (p) => p?.status === 'out_for_delivery',
  );
  await api('POST', `/orders/${orderId}/status`, S, { status: 'out_for_delivery' });
  await statusEvt;
  pass('order.status_changed (out_for_delivery)');

  const trackEvt = waitForEvent<any>(socket, 'tracking.location_updated', 45_000);
  await api('POST', `/orders/${orderId}/tracking`, S, { lat: 12.98, lng: 77.58, speed: 20 });
  await trackEvt;
  pass('tracking.location_updated');

  const chatEvt = waitForEvent<any>(socket, 'chat.message_created', 45_000);
  await api('POST', `/orders/${orderId}/chat/messages`, S, { body: 'Socket smoke: on the way' });
  await chatEvt;
  pass('chat.message_created');

  socket.close();

  log('\n=== SOCKET SUMMARY ===');
  log(`Passed: ${steps.filter((s) => s.ok).length}/${steps.length}`);
  log('SOCKET LOOP OK\n');
}

main().catch((e) => {
  console.error('\n' + (e instanceof Error ? e.message : String(e)));
  console.error(`Passed before fail: ${steps.filter((s) => s.ok).length}`);
  process.exit(1);
});
