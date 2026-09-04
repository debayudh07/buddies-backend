/**
 * Full consumer ↔ supplier loop smoke test (dev auth).
 * Run: npx tsx scripts/full-loop-smoke.ts
 * Requires: API up (PORT from .env), DEV_AUTH_BYPASS=true, seeded DB.
 */
/// <reference types="node" />
import 'dotenv/config';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const PORT = process.env.PORT ?? '8000';
const ROOT = process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`;
const BASE = process.env.SMOKE_BASE_URL ?? `${ROOT}/v1`;

const C = 'dev:consumer:11111111-1111-4111-8111-111111111111';
const S = 'dev:supplier:22222222-2222-4222-8222-222222222222';
const A = 'dev:admin:33333333-3333-4333-8333-333333333333';

/** 1×1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type StepResult = { ok: boolean; step: string; detail?: string };

const results: StepResult[] = [];
let failed = false;

function log(msg: string) {
  console.log(msg);
}

async function api(
  step: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<any> {
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
    const detail = `HTTP ${res.status} ${method} ${path} → ${text.slice(0, 400)}`;
    results.push({ ok: false, step, detail });
    failed = true;
    throw new Error(`[FAIL] ${step}: ${detail}`);
  }
  results.push({ ok: true, step });
  log(`  ✓ ${step}`);
  return data;
}

async function expectHttp(
  step: string,
  method: string,
  path: string,
  token: string,
  body: unknown,
  status: number,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status !== status) {
    const text = await res.text();
    const detail = `expected HTTP ${status}, got ${res.status} ${method} ${path} → ${text.slice(0, 400)}`;
    results.push({ ok: false, step, detail });
    failed = true;
    throw new Error(`[FAIL] ${step}: ${detail}`);
  }
  results.push({ ok: true, step });
  log(`  ✓ ${step} (${status})`);
}

async function upload(
  step: string,
  purpose: string,
  token: string,
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<any> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mime }), filename);
  const res = await fetch(`${BASE}/uploads?purpose=${encodeURIComponent(purpose)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = `HTTP ${res.status} POST /uploads?purpose=${purpose} → ${text.slice(0, 400)}`;
    results.push({ ok: false, step, detail });
    failed = true;
    throw new Error(`[FAIL] ${step}: ${detail}`);
  }
  results.push({ ok: true, step });
  log(`  ✓ ${step} → ${data.storageRef}`);
  return data;
}

async function main() {
  log(`\n=== Buddies full-loop smoke @ ${BASE} ===\n`);

  // 0. Health + FCM readiness
  log('0. Health / FCM');
  const healthRes = await fetch(`${ROOT}/health`);
  const health = (await healthRes.json()) as {
    ok?: boolean;
    fcm?: { enabled?: boolean; ready?: boolean };
  };
  if (!healthRes.ok || !health.ok) {
    throw new Error(`[FAIL] health: ${JSON.stringify(health)}`);
  }
  results.push({ ok: true, step: 'health ok' });
  log(`  ✓ health ok (fcm.enabled=${health.fcm?.enabled} ready=${health.fcm?.ready})`);
  if (health.fcm?.enabled && !health.fcm.ready) {
    results.push({
      ok: false,
      step: 'fcm ready',
      detail: 'FCM_ENABLED=true but Firebase Admin not ready — check service account path',
    });
    failed = true;
    throw new Error('[FAIL] fcm ready: Firebase Admin not initialized');
  }
  if (health.fcm?.enabled && health.fcm.ready) {
    results.push({ ok: true, step: 'fcm ready' });
    log('  ✓ fcm ready');
  }

  // 1. Identity
  log('\n1. Identity bootstrap');
  const cSession = await api('consumer session', 'POST', '/auth/session', C);
  await api('consumer profile', 'PUT', '/consumer/profile', C, {
    restaurantName: 'Smoke Kitchen',
    addressLine: '12 MG Road',
    city: 'Bengaluru',
    lat: 12.97,
    lng: 77.59,
    displayName: 'Priya Sharma',
  });
  await api('consumer privacy', 'POST', '/me/privacy-accept', C);
  const addrRes = await api('consumer address', 'POST', '/consumer/addresses', C, {
    label: 'Kitchen',
    line: '12 MG Road',
    city: 'Bengaluru',
    lat: 12.97,
    lng: 77.59,
    isDefault: true,
  });
  const addressId = addrRes.address?.id as string | undefined;
  if (!addressId) throw new Error('No address.id');

  const sSession = await api('supplier session', 'POST', '/auth/session', S);
  const supplierUserId = sSession.user?.id ?? '22222222-2222-4222-8222-222222222222';

  // FCM device tokens (invalid tokens exercise send path + stale cleanup; must not crash API)
  log('\n1b. FCM device registration');
  await api('consumer device', 'POST', '/devices', C, {
    token: `smoke-fcm-consumer-${Date.now()}`,
    platform: 'android',
  });
  await api('supplier device', 'POST', '/devices', S, {
    token: `smoke-fcm-supplier-${Date.now()}`,
    platform: 'android',
  });

  // 2. KYC (+ optional KYC image upload)
  log('\n2. Supplier KYC');
  const kycUpload = await upload('kyc image upload', 'kyc', S, TINY_PNG, 'kyc.png', 'image/png');
  await api('kyc upsert', 'POST', '/supplier/kyc', S, {
    businessName: 'Smoke Fresh Mart',
    ownerName: 'Ravi Kumar',
    ownerPhone: '+919876543210',
    gstin: '29AAAAA0000A1Z5',
    aadhaarRef: kycUpload.storageRef,
    shopAddressPrivate: 'Warehouse 4, Peenya',
    publicLabel: 'Fresh Mart Peenya',
    lat: 13.03,
    lng: 77.52,
    categories: ['vegetables', 'dairy'],
  });
  await api('kyc submit', 'POST', '/supplier/kyc/submit', S);
  try {
    await api('kyc admin verify', 'POST', `/admin/supplier/${supplierUserId}/verify`, A);
  } catch {
    failed = false;
    results.pop();
    await api('kyc dev-verify', 'POST', '/supplier/kyc/dev-verify', S);
  }

  // 3. Subscriptions
  log('\n3. Subscriptions');
  await api('consumer sub', 'POST', '/subscriptions', C, { plan: 'consumer_standard' });
  await api('supplier sub', 'POST', '/subscriptions', S, {
    plan: 'supplier_standard',
    introPrice: true,
  });

  // 4. Demand
  log('\n4. Consumer bid request');
  const br = await api('create bid-request', 'POST', '/consumer/bid-requests', C, {
    privacyAccepted: true,
    budgetPaise: 500000,
    durationHours: 24,
    deliveryWindow: 'tomorrow 6-8am',
    addressId,
    items: [
      {
        name: 'Tomatoes',
        quantity: 10,
        unit: 'kg',
        productCategory: 'vegetables',
        gradeHint: 'A',
      },
    ],
  });
  const bidRequestId = br.bidRequest?.id ?? br.id;
  if (!bidRequestId) throw new Error('No bidRequest.id');
  const brLat = br.bidRequest?.lat ?? br.lat;
  const brLng = br.bidRequest?.lng ?? br.lng;
  const brAddr = br.bidRequest?.deliveryAddress ?? br.deliveryAddress;
  if (brLat !== 12.97 || brLng !== 77.59) {
    throw new Error(`BidRequest pin missing: lat=${brLat} lng=${brLng}`);
  }
  if (!brAddr || !String(brAddr).includes('12 MG Road')) {
    throw new Error(`BidRequest deliveryAddress missing: ${brAddr}`);
  }
  results.push({ ok: true, step: 'bid-request has delivery pin + address' });
  log('  ✓ bid-request has delivery pin + address');

  // 5. Bidzone + bid
  log('\n5. Supplier Bidzone + bid');
  await api('bidzone feed', 'GET', '/supplier/bidzone', S);
  const bidRes = await api('place bid', 'POST', '/supplier/bids', S, {
    bidRequestId,
    amountPaise: 450000,
    grade: 'A',
    shelfLifeDays: 5,
    rslDaysAtDelivery: 3,
    notes: 'Harvested today',
  });
  const bidId = bidRes.bid?.id ?? bidRes.id;
  if (!bidId) throw new Error('No bid.id');
  await api('list bids', 'GET', `/consumer/bid-requests/${bidRequestId}/bids`, C);

  // 6–7. Accept bid (bind-on-accept creates order immediately)
  log('\n6–7. Accept bid → order (bind-on-accept)');
  const acceptRes = await api('accept bid', 'POST', `/consumer/bids/${bidId}/accept`, C);
  let orderId = acceptRes.order?.id ?? acceptRes.orderId;
  // Optional party confirms (never required to open the order)
  await api('consumer ack (optional)', 'POST', `/bids/${bidId}/acknowledge`, C, {
    role: 'consumer',
  });
  const ack2 = await api('supplier ack (optional)', 'POST', `/bids/${bidId}/acknowledge`, S, {
    role: 'supplier',
  });
  orderId = orderId ?? ack2.order?.id ?? ack2.id;
  if (!orderId) throw new Error('No order.id after accept');
  log(`  → order ${orderId} (${acceptRes.order?.orderCode ?? ack2.order?.orderCode ?? ''})`);

  const orderDetail = await api('get order', 'GET', `/orders/${orderId}`, S);
  const order = orderDetail.order ?? orderDetail;
  if (order.hasDeliveryPin !== true) {
    throw new Error(`Order missing hasDeliveryPin (got ${order.hasDeliveryPin})`);
  }
  if (order.deliveryLat !== 12.97 || order.deliveryLng !== 77.59) {
    throw new Error(
      `Order pin mismatch: lat=${order.deliveryLat} lng=${order.deliveryLng}`,
    );
  }
  if (!order.deliveryAddress || !String(order.deliveryAddress).includes('12 MG Road')) {
    throw new Error(`Order deliveryAddress missing: ${order.deliveryAddress}`);
  }
  if (order.deliveryWindow !== 'tomorrow 6-8am') {
    throw new Error(`Order deliveryWindow missing: ${order.deliveryWindow}`);
  }
  results.push({ ok: true, step: 'order exposes delivery pin + window to supplier' });
  log('  ✓ order exposes delivery pin + window to supplier');

  // Chat (+ image upload)
  log('\n8. Chat');
  const chatUpload = await upload('chat image upload', 'chat', S, TINY_PNG, 'chat.png', 'image/png');
  await api('chat message', 'POST', `/orders/${orderId}/chat/messages`, S, {
    body: 'ETA 15 min, please keep fridge space ready',
    imageRef: chatUpload.storageRef,
  });
  await api('chat history', 'GET', `/orders/${orderId}/chat`, C);

  // Status + tracking
  log('\n9. Status + GPS tracking');
  await api('status preparing', 'POST', `/orders/${orderId}/status`, S, {
    status: 'preparing',
    note: 'Packing',
  });
  await api('status out_for_delivery', 'POST', `/orders/${orderId}/status`, S, {
    status: 'out_for_delivery',
  });
  await api('tracking point', 'POST', `/orders/${orderId}/tracking`, S, {
    lat: 12.98,
    lng: 77.58,
    heading: 90,
    speed: 25.5,
  });
  await api('tracking live', 'GET', `/orders/${orderId}/tracking/live`, C);
  await api('status arrived', 'POST', `/orders/${orderId}/status`, S, { status: 'arrived' });

  // Challan + invoice (signature stored in Supabase)
  log('\n10. Challan');
  await api('inspection start', 'POST', `/orders/${orderId}/inspection/start`, C);
  const sigUpload = await upload(
    'challan signature upload',
    'challans',
    C,
    TINY_PNG,
    'sig.png',
    'image/png',
  );
  await api('sign challan', 'POST', `/orders/${orderId}/inspection/sign-challan`, C, {
    signatureRef: sigUpload.storageRef,
  });
  await api('get challan', 'GET', `/orders/${orderId}/challan`, C);
  await expectHttp('invoice not before payment', 'GET', `/orders/${orderId}/invoice`, C, undefined, 404);

  // Return with real Storage evidence
  log('\n11. Return claim + storage evidence');
  await api('return windows', 'GET', '/returns/windows', C);
  const orderForReturn = await api('order detail for return', 'GET', `/orders/${orderId}`, C);
  const returnLineIds = (orderForReturn.order?.items ?? [])
    .map((i: { id?: string }) => i.id)
    .filter((id: string | undefined): id is string => !!id);
  if (!returnLineIds.length) throw new Error('Order has no returnable line items');

  await expectHttp(
    'return requires line items',
    'POST',
    `/orders/${orderId}/return-claims`,
    C,
    { reasonCode: 'leakage', productCategory: 'vegetables', lineItemIds: [] },
    400,
  );
  await expectHttp(
    'foreign line ids rejected',
    'POST',
    `/orders/${orderId}/return-claims`,
    C,
    { reasonCode: 'leakage', productCategory: 'vegetables', lineItemIds: ['not-an-item'] },
    400,
  );
  await expectHttp(
    'wrong category rejected',
    'POST',
    `/orders/${orderId}/return-claims`,
    C,
    { reasonCode: 'leakage', productCategory: 'frozen_food', lineItemIds: returnLineIds },
    400,
  );

  const claim = await api('create return', 'POST', `/orders/${orderId}/return-claims`, C, {
    reasonCode: 'leakage',
    productCategory: 'vegetables',
    lineItemIds: returnLineIds,
    notes: 'Puncture on bag',
  });
  const claimId = claim.claim?.id ?? claim.id;
  const evidenceUpload = await upload(
    'return evidence upload',
    'returns',
    C,
    TINY_PNG,
    'leak.png',
    'image/png',
  );
  for (const lineId of returnLineIds) {
    await api(`return evidence ${lineId.slice(0, 8)}`, 'POST', `/return-claims/${claimId}/evidence`, C, {
      storageRef: evidenceUpload.storageRef,
      mediaType: evidenceUpload.mediaType,
      defectNote: 'Leak visible',
      lineItemId: lineId,
    });
  }
  await api('signed url', 'GET', `/uploads/signed-url?storageRef=${encodeURIComponent(evidenceUpload.storageRef)}`, C);
  await api('return submit', 'POST', `/return-claims/${claimId}/submit`, C);

  log('\n11b. Return: full offline refund loop');
  await expectHttp(
    'consumer cannot record refund',
    'POST',
    `/return-claims/${claimId}/refund`,
    C,
    { amountPaise: 10000 },
    403,
  );
  await expectHttp(
    'supplier cannot consumer-ack',
    'POST',
    `/return-claims/${claimId}/consumer-ack`,
    S,
    undefined,
    403,
  );
  await api('return accept + pickup window', 'POST', `/return-claims/${claimId}/supplier-decision`, S, {
    decision: 'accept',
    resolutionType: 'refund',
    pickupWindow: 'Tomorrow 4-6 pm',
    notes: 'Pickup at the back gate',
  });
  await api('return schedule pickup', 'POST', `/return-claims/${claimId}/schedule-pickup`, S, {
    pickupWindow: 'Tomorrow 4-6 pm',
  });
  const chat = await api('return chat get', 'GET', `/return-claims/${claimId}/chat`, C);
  log(`  → return thread ${chat.threadId ?? chat.thread?.id ?? '(ok)'}`);
  await api('return chat send', 'POST', `/return-claims/${claimId}/chat/messages`, C, {
    body: 'Bag is ready at the back gate',
  });
  await api('return chat typing', 'POST', `/return-claims/${claimId}/chat/typing`, S, {
    typing: true,
  });
  await api('return confirm pickup', 'POST', `/return-claims/${claimId}/confirm-pickup`, S);
  await api('return record refund', 'POST', `/return-claims/${claimId}/refund`, S, {
    amountPaise: 50000,
    receiptRef: 'UPI-REFUND-SMOKE-1',
  });
  await api('return consumer ack', 'POST', `/return-claims/${claimId}/consumer-ack`, C);

  log('\n11c. Return: replacement loop');
  const claim2 = await api('create replacement return', 'POST', `/orders/${orderId}/return-claims`, C, {
    reasonCode: 'leakage',
    productCategory: 'vegetables',
    lineItemIds: returnLineIds,
    notes: 'Need replacement crate',
  });
  const claim2Id = claim2.claim?.id ?? claim2.id;
  for (const lineId of returnLineIds) {
    await api(
      `replacement evidence ${lineId.slice(0, 8)}`,
      'POST',
      `/return-claims/${claim2Id}/evidence`,
      C,
      {
        storageRef: evidenceUpload.storageRef,
        mediaType: evidenceUpload.mediaType,
        defectNote: 'Swap needed',
        lineItemId: lineId,
      },
    );
  }
  await api('replacement submit', 'POST', `/return-claims/${claim2Id}/submit`, C);
  await api('replacement accept', 'POST', `/return-claims/${claim2Id}/supplier-decision`, S, {
    decision: 'accept',
    resolutionType: 'replacement',
  });
  await api('replacement confirm pickup', 'POST', `/return-claims/${claim2Id}/confirm-pickup`, S);
  await expectHttp(
    'cannot refund a replacement claim',
    'POST',
    `/return-claims/${claim2Id}/refund`,
    S,
    { amountPaise: 10000 },
    400,
  );
  await api('replacement delivered', 'POST', `/return-claims/${claim2Id}/replaced`, S);
  await api('replacement consumer ack', 'POST', `/return-claims/${claim2Id}/consumer-ack`, C);

  // Offline payment (+ screenshot upload) — FCM fires on return submit / status changes
  log('\n12. Offline payment');
  await api('payment start', 'POST', `/orders/${orderId}/payment/start`, C, {
    methodNote: 'UPI',
  });
  const payUpload = await upload(
    'payment screenshot upload',
    'payments',
    C,
    TINY_PNG,
    'upi.png',
    'image/png',
  );
  await api('payment mark-paid', 'POST', `/orders/${orderId}/payment/mark-paid`, C, {
    reference: 'UPI-TXN-SMOKE-1',
    screenshotRef: payUpload.storageRef,
    methodNote: 'UPI',
  });
  await api('payment confirm', 'POST', `/orders/${orderId}/payment/confirm`, S);
  const inv = await api('get invoice after paid', 'GET', `/orders/${orderId}/invoice`, C);
  if (!inv.invoice?.paid) {
    throw new Error('Invoice should be marked paid after supplier confirm');
  }

  // Support
  log('\n13. Support');
  await api('articles list', 'GET', '/support/articles', C);
  await api('article by slug', 'GET', '/support/articles/digital-challan', C);
  await api('create ticket', 'POST', '/support/tickets', C, {
    category: 'orders',
    subject: 'Smoke test ticket',
    body: 'Verifying support ticket create on order',
    orderId,
  });

  // Summary
  log('\n=== SUMMARY ===');
  log(`Passed: ${results.filter((r) => r.ok).length}/${results.length}`);
  log(`Consumer: ${cSession.user?.id ?? C}`);
  log(`Supplier: ${supplierUserId}`);
  log(`BidRequest: ${bidRequestId}`);
  log(`Bid: ${bidId}`);
  log(`Order: ${orderId}`);
  log(`Return claim: ${claimId}`);
  if (failed) {
    process.exitCode = 1;
    log('\nFAILED');
    for (const r of results.filter((x) => !x.ok)) {
      log(`  ✗ ${r.step}: ${r.detail ?? ''}`);
    }
  } else {
    log('\nFULL LOOP OK');
  }
}

main().catch((e) => {
  console.error('\n' + (e instanceof Error ? e.message : String(e)));
  console.error(`\nPassed before fail: ${results.filter((r) => r.ok).length}`);
  for (const r of results.filter((x) => !x.ok)) {
    console.error(`  ✗ ${r.step}: ${r.detail ?? ''}`);
  }
  process.exit(1);
});
