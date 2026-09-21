/**
 * Bulk concurrent marketplace load test.
 *
 * Spins up N synthetic consumers + N synthetic suppliers (dev-auth bearer
 * tokens — requires DEV_AUTH_BYPASS=true on the target backend), drives each
 * pair through the full marketplace loop concurrently — KYC, catalog browse,
 * bid-request creation, bidzone feed, bidding, accept, order lifecycle,
 * payment, invoice, ratings, notifications — then deletes every row it
 * created.
 *
 * Run:
 *   npx tsx scripts/bulk-marketplace-load-test.ts
 *
 * Env (all optional):
 *   LOAD_BASE_URL     backend root, no trailing slash (default: the deployed
 *                      Render URL below)
 *   LOAD_COUNT        users PER ROLE — total identities = 2x this (default 500)
 *   LOAD_CONCURRENCY  max concurrent in-flight HTTP requests, across all
 *                      pairs (default 40 — keep modest, this hits a live
 *                      shared Render instance + Supabase project)
 *   LOAD_TIMEOUT_MS   per-request timeout (default 30000)
 *   LOAD_SKIP_CLEANUP set to "1" to leave the created rows in place (for
 *                      inspection) — re-run with LOAD_CLEANUP_ONLY=1 later
 *   LOAD_CLEANUP_ONLY set to "1" to skip the load test and only delete rows
 *                      matching the lt- id prefix (idempotent, safe to re-run)
 *
 * Cleanup uses Prisma directly against DATABASE_URL / DIRECT_URL from
 * backend/.env — must point at the same Postgres the target API writes to.
 */
/// <reference types="node" />
import "dotenv/config";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT =
  process.env.LOAD_BASE_URL?.replace(/\/$/, "") ??
  "https://buddies-backend-pp6e.onrender.com";
const BASE = `${ROOT}/v1`;
const COUNT = Number(process.env.LOAD_COUNT ?? 500);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 40);
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 30_000);
const SKIP_CLEANUP = process.env.LOAD_SKIP_CLEANUP === "1";
const CLEANUP_ONLY = process.env.LOAD_CLEANUP_ONLY === "1";
const ID_PREFIX = "lt"; // every id/phone this script creates starts with this

function pad(n: number, width = 5): string {
  return String(n).padStart(width, "0");
}
const consumerId = (i: number) => `${ID_PREFIX}-c-${pad(i)}`;
const supplierId = (i: number) => `${ID_PREFIX}-s-${pad(i)}`;
const consumerPhone = (i: number) => `+9179${pad(i, 8)}`;
const supplierPhone = (i: number) => `+9178${pad(i, 8)}`;

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Concurrency-limited HTTP client + metrics
// ---------------------------------------------------------------------------

class Semaphore {
  private free: number;
  private queue: Array<() => void> = [];
  constructor(n: number) {
    this.free = n;
  }
  acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
}
const sem = new Semaphore(CONCURRENCY);

type ApiResult<T = any> = { ok: boolean; status: number; data: T; ms: number };

const metrics = new Map<string, { ok: number; fail: number; ms: number[] }>();
function record(route: string, r: ApiResult) {
  const m = metrics.get(route) ?? { ok: 0, fail: 0, ms: [] };
  if (r.ok) m.ok++;
  else m.fail++;
  m.ms.push(r.ms);
  metrics.set(route, m);
}

async function call<T = any>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  attempt = 0,
): Promise<ApiResult<T>> {
  await sem.acquire();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data, ms: Date.now() - started };
  } catch (e) {
    // One retry on network-level failure (timeout / reset) — not on HTTP errors.
    if (attempt < 1) {
      clearTimeout(timer);
      sem.release();
      return call(method, path, token, body, attempt + 1);
    }
    return {
      ok: false,
      status: 0,
      data: { error: e instanceof Error ? e.message : String(e) } as any,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    sem.release();
  }
}

async function req<T = any>(
  route: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const r = await call<T>(method, path, token, body);
  record(route, r);
  return r;
}

function must<T>(r: ApiResult<T>, label: string): T {
  if (!r.ok) {
    throw new Error(`${label} → HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Phase 0 — warm up the Render instance
// ---------------------------------------------------------------------------

async function warmup() {
  log(`Warming up ${ROOT} ...`);
  const deadline = Date.now() + 120_000;
  let goodStreak = 0;
  while (Date.now() < deadline) {
    const r = await pingHealth();
    log(`  GET /health → ${r.ok ? "ok" : `fail(${r.status})`} in ${r.ms}ms`);
    if (r.ok && r.ms < 3000) {
      goodStreak++;
      if (goodStreak >= 2) {
        log("Backend is warm.");
        return;
      }
    } else {
      goodStreak = 0;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  log("Warmup timed out — proceeding anyway (first real requests may be slow).");
}

// health lives at root, not /v1 — call() always prefixes BASE (=ROOT+/v1),
// so hit it directly here instead of reusing call().
async function pingHealth(): Promise<ApiResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${ROOT}/health`);
    const ok = res.ok;
    return { ok, status: res.status, data: null, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, data: { error: String(e) }, ms: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------
// Catalog + shelf-life matrix (fetched once, shared by every pair)
// ---------------------------------------------------------------------------

type Group = {
  categorySlug: string;
  productCategory: string;
  items: { slug: string; name: string }[];
  moqQty: number;
  moqUnit: string;
  packSize?: string;
};

async function buildGroups(token: string): Promise<Group[]> {
  const r = await req("GET /catalog/order-items", "GET", "/catalog/order-items?full=1", token);
  const categories = must<any>(r, "catalog fetch").categories as any[];
  const groups: Group[] = [];
  for (const c of categories) {
    const byProductCategory = new Map<string, any[]>();
    for (const it of c.items ?? []) {
      const arr = byProductCategory.get(it.productCategory) ?? [];
      arr.push(it);
      byProductCategory.set(it.productCategory, arr);
    }
    let best: any[] | null = null;
    for (const arr of byProductCategory.values()) {
      if (!best || arr.length > best.length) best = arr;
    }
    if (best && best.length >= 3) {
      groups.push({
        categorySlug: c.slug,
        productCategory: best[0].productCategory,
        items: best.slice(0, 3),
        moqQty: c.moqQty,
        moqUnit: c.moqUnit,
        packSize: c.packSizeKind ? c.packSizeOptions?.[0] : undefined,
      });
    }
  }
  if (groups.length === 0) throw new Error("No usable catalog categories found");
  return groups;
}

async function buildShelfMatrix(
  token: string,
): Promise<Map<string, { minRslDays: number; totalShelfLifeDays: number }>> {
  const r = await req("GET /catalog/shelf-life-matrix", "GET", "/catalog/shelf-life-matrix", token);
  const map = new Map<string, { minRslDays: number; totalShelfLifeDays: number }>();
  if (r.ok) {
    for (const row of (r.data as any).matrix ?? []) {
      if (row.productCategory) {
        map.set(row.productCategory, {
          minRslDays: row.minRslDays ?? 2,
          totalShelfLifeDays: row.totalShelfLifeDays ?? 5,
        });
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// One pair's full lifecycle
// ---------------------------------------------------------------------------

type PairIds = {
  i: number;
  consumerUserId: string;
  supplierUserId: string;
  consumerProfileId?: string;
  supplierProfileId?: string;
  bidRequestId?: string;
  bidId?: string;
  orderId?: string;
  error?: string;
};

async function bootstrapConsumer(i: number, group: Group) {
  const id = consumerId(i);
  const token = `dev:consumer:${id}`;
  must(await req("POST /auth/session (consumer)", "POST", "/auth/session", token, { intendedRole: "consumer" }), `session c${i}`);
  const kyc = must<any>(
    await req("POST /consumer/kyc", "POST", "/consumer/kyc", token, {
      restaurantName: `LoadTest Kitchen ${i}`,
      ownerName: `Owner C${i}`,
      ownerPhone: consumerPhone(i),
      addressLine: `${i} Load Test Street`,
      city: "Load City",
      publicLabel: `LT Kitchen ${i}`,
      lat: 12.9 + (i % 200) * 0.001,
      lng: 77.6 + (i % 200) * 0.001,
    }),
    `kyc c${i}`,
  );
  must(await req("POST /consumer/kyc/dev-verify", "POST", "/consumer/kyc/dev-verify", token), `dev-verify c${i}`);
  return { token, consumerProfileId: kyc.profile?.id as string | undefined };
}

async function bootstrapSupplier(i: number, group: Group) {
  const id = supplierId(i);
  const token = `dev:supplier:${id}`;
  must(await req("POST /auth/session (supplier)", "POST", "/auth/session", token, { intendedRole: "supplier" }), `session s${i}`);
  const kyc = must<any>(
    await req("POST /supplier/kyc", "POST", "/supplier/kyc", token, {
      businessName: `LoadTest Shop ${i}`,
      ownerName: `Owner S${i}`,
      ownerPhone: supplierPhone(i),
      shopAddressPrivate: `${i} Load Test Lane`,
      publicLabel: `LT Shop ${i}`,
      lat: 12.9 + (i % 200) * 0.001,
      lng: 77.6 + (i % 200) * 0.001,
      categories: [group.productCategory],
    }),
    `kyc s${i}`,
  );
  must(await req("POST /supplier/kyc/dev-verify", "POST", "/supplier/kyc/dev-verify", token), `dev-verify s${i}`);
  return { token, supplierProfileId: kyc.profile?.id as string | undefined };
}

async function createBidRequest(i: number, token: string, group: Group) {
  const items = group.items.map((it) => ({
    catalogCategory: group.categorySlug,
    catalogItemSlug: it.slug,
    quantity: group.moqQty,
    unit: group.moqUnit,
    ...(group.packSize ? { packSize: group.packSize } : {}),
  }));
  const budgetPaise = items.length * Math.max(1, group.moqQty) * 5000;
  const data = must<any>(
    await req("POST /consumer/bid-requests", "POST", "/consumer/bid-requests", token, {
      privacyAccepted: true,
      durationHours: 0,
      slaHours: 6,
      budgetPaise,
      deliveryWindow: "Load test — within 6 hours",
      items,
    }),
    `bid-request c${i}`,
  );
  return { bidRequestId: data.bidRequest.id as string, budgetPaise };
}

async function placeBid(
  i: number,
  token: string,
  bidRequestId: string,
  budgetPaise: number,
  group: Group,
  shelf: Map<string, { minRslDays: number; totalShelfLifeDays: number }>,
) {
  // Coverage: browse the feed before bidding, like the real app does.
  await req("GET /supplier/bidzone", "GET", "/supplier/bidzone", token);
  const rules = shelf.get(group.productCategory) ?? { minRslDays: 2, totalShelfLifeDays: 5 };
  const amountPaise = Math.max(100, Math.round(budgetPaise * 0.85));
  const data = must<any>(
    await req("POST /supplier/bids", "POST", "/supplier/bids", token, {
      bidRequestId,
      amountPaise,
      grade: "A",
      shelfLifeDays: rules.totalShelfLifeDays,
      rslDaysAtDelivery: rules.minRslDays,
    }),
    `place-bid s${i}`,
  );
  return { bidId: data.bid.id as string };
}

async function runOrderLifecycle(
  i: number,
  consumerToken: string,
  supplierToken: string,
  orderId: string,
) {
  await req("GET /orders/:id", "GET", `/orders/${orderId}`, consumerToken);
  must(
    await req("POST /orders/:id/status (preparing)", "POST", `/orders/${orderId}/status`, supplierToken, { status: "preparing" }),
    `preparing ${i}`,
  );
  must(
    await req("POST /orders/:id/status (out_for_delivery)", "POST", `/orders/${orderId}/status`, supplierToken, { status: "out_for_delivery" }),
    `out_for_delivery ${i}`,
  );
  await req("GET /orders/:id/tracking/live", "GET", `/orders/${orderId}/tracking/live`, consumerToken);
  must(
    await req("POST /orders/:id/status (arrived)", "POST", `/orders/${orderId}/status`, supplierToken, { status: "arrived" }),
    `arrived ${i}`,
  );
  await req("POST /orders/:id/inspection/start", "POST", `/orders/${orderId}/inspection/start`, consumerToken);
  must(
    await req("POST /orders/:id/inspection/sign-challan", "POST", `/orders/${orderId}/inspection/sign-challan`, consumerToken, {}),
    `sign-challan ${i}`,
  );
  await req("GET /orders/:id/challan", "GET", `/orders/${orderId}/challan`, supplierToken);
  must(
    await req("POST /orders/:id/payment/confirm", "POST", `/orders/${orderId}/payment/confirm`, supplierToken),
    `payment-confirm ${i}`,
  );
  await req("GET /orders/:id/invoice", "GET", `/orders/${orderId}/invoice`, consumerToken);
  await req("POST /orders/:id/ratings (consumer→supplier)", "POST", `/orders/${orderId}/ratings`, consumerToken, { stars: 5, comment: "Load test" });
  await req("POST /orders/:id/ratings (supplier→consumer)", "POST", `/orders/${orderId}/ratings`, supplierToken, { stars: 5, comment: "Load test" });
  await req("GET /notifications/unread-count", "GET", "/notifications/unread-count", consumerToken);
  await req("GET /notifications/unread-count", "GET", "/notifications/unread-count", supplierToken);
  await req("GET /consumer/orders", "GET", "/consumer/orders", consumerToken);
  await req("GET /supplier/orders", "GET", "/supplier/orders", supplierToken);
}

async function runPair(
  i: number,
  groups: Group[],
  shelf: Map<string, { minRslDays: number; totalShelfLifeDays: number }>,
): Promise<PairIds> {
  const group = groups[i % groups.length]!;
  const ids: PairIds = { i, consumerUserId: consumerId(i), supplierUserId: supplierId(i) };
  try {
    const [consumer, supplier] = await Promise.all([
      bootstrapConsumer(i, group),
      bootstrapSupplier(i, group),
    ]);
    ids.consumerProfileId = consumer.consumerProfileId;
    ids.supplierProfileId = supplier.supplierProfileId;

    const { bidRequestId, budgetPaise } = await createBidRequest(i, consumer.token, group);
    ids.bidRequestId = bidRequestId;

    // Coverage: consumer sees the request in their list before any bid lands.
    await req("GET /consumer/bid-requests", "GET", "/consumer/bid-requests", consumer.token);

    const { bidId } = await placeBid(i, supplier.token, bidRequestId, budgetPaise, group, shelf);
    ids.bidId = bidId;

    await req(
      "GET /consumer/bid-requests/:id/bids",
      "GET",
      `/consumer/bid-requests/${bidRequestId}/bids`,
      consumer.token,
    );

    const accepted = must<any>(
      await req("POST /consumer/bids/:id/accept", "POST", `/consumer/bids/${bidId}/accept`, consumer.token),
      `accept ${i}`,
    );
    ids.orderId = accepted.orderId as string;

    await runOrderLifecycle(i, consumer.token, supplier.token, ids.orderId);
  } catch (e) {
    ids.error = e instanceof Error ? e.message : String(e);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Cleanup — deletes everything with an `lt-` id, in FK-safe order. Idempotent.
// ---------------------------------------------------------------------------

function chunk<T>(arr: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function cleanupAll(prisma: PrismaClient) {
  log("Cleanup: scanning for load-test rows ...");
  const users = await prisma.user.findMany({
    where: { id: { startsWith: `${ID_PREFIX}-` } },
    select: { id: true, consumerProfile: { select: { id: true } }, supplierProfile: { select: { id: true } } },
  });
  const userIds = users.map((u) => u.id);
  const consumerProfileIds = users.map((u) => u.consumerProfile?.id).filter((v): v is string => !!v);
  const supplierProfileIds = users.map((u) => u.supplierProfile?.id).filter((v): v is string => !!v);

  if (userIds.length === 0) {
    log("Cleanup: nothing to delete.");
    return;
  }

  const bidRequests = await prisma.bidRequest.findMany({
    where: { consumerId: { in: consumerProfileIds } },
    select: { id: true },
  });
  const bidRequestIds = bidRequests.map((b) => b.id);

  const orders = await prisma.order.findMany({
    where: { OR: [{ consumerUserId: { in: userIds } }, { supplierUserId: { in: userIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  log(
    `Cleanup: ${userIds.length} users, ${bidRequestIds.length} bid requests, ${orderIds.length} orders.`,
  );

  // 1) Orders — cascades ratings, status events, tracking, challan, invoice,
  //    payment, chat threads/messages, handoffs.
  for (const c of chunk(orderIds)) {
    if (c.length) await prisma.order.deleteMany({ where: { id: { in: c } } });
  }

  // 2) Clear the one non-cascading FK hazard (awarded-item → bid) before
  //    cascading the bid request away.
  for (const c of chunk(bidRequestIds)) {
    if (c.length) {
      await prisma.bidRequestItem.updateMany({
        where: { bidRequestId: { in: c } },
        data: { awardedBidId: null },
      });
    }
  }

  // 3) Bid requests — cascades items, bid lines, bids, standing RFQ.
  for (const c of chunk(bidRequestIds)) {
    if (c.length) await prisma.bidRequest.deleteMany({ where: { id: { in: c } } });
  }

  // 4) Profiles — cascades addresses (consumer side).
  for (const c of chunk(consumerProfileIds)) {
    if (c.length) await prisma.consumerProfile.deleteMany({ where: { id: { in: c } } });
  }
  for (const c of chunk(supplierProfileIds)) {
    if (c.length) await prisma.supplierProfile.deleteMany({ where: { id: { in: c } } });
  }

  // 5) Users — cascades notifications, device tokens, prefs, subscriptions.
  for (const c of chunk(userIds)) {
    if (c.length) await prisma.user.deleteMany({ where: { id: { in: c } } });
  }

  log("Cleanup: done.");
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function printReport() {
  console.log("\n" + "=".repeat(96));
  console.log("ROUTE METRICS");
  console.log("=".repeat(96));
  const rows = [...metrics.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const header = ["route", "ok", "fail", "p50ms", "p95ms", "maxms"];
  console.log(header.map((h) => h.padEnd(16)).join(""));
  let totalOk = 0;
  let totalFail = 0;
  for (const [route, m] of rows) {
    const sorted = [...m.ms].sort((a, b) => a - b);
    totalOk += m.ok;
    totalFail += m.fail;
    console.log(
      [
        route.padEnd(48).slice(0, 48),
        String(m.ok).padEnd(8),
        String(m.fail).padEnd(8),
        String(percentile(sorted, 50)).padEnd(8),
        String(percentile(sorted, 95)).padEnd(8),
        String((sorted.length ? sorted[sorted.length - 1] : 0) ?? 0).padEnd(8),
      ].join(""),
    );
  }
  console.log("-".repeat(96));
  console.log(`TOTAL requests: ${totalOk + totalFail}  ok: ${totalOk}  fail: ${totalFail}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const prisma = new PrismaClient();
  try {
    if (CLEANUP_ONLY) {
      await cleanupAll(prisma);
      return;
    }

    log(`Target: ${ROOT}`);
    log(`Plan: ${COUNT} consumers + ${COUNT} suppliers, concurrency=${CONCURRENCY}`);

    await warmup();

    // Preflight: confirm dev-auth bypass is actually enabled on the target —
    // otherwise every one of the next several thousand requests will 401.
    const bootToken = `dev:consumer:${ID_PREFIX}-boot-0000`;
    const preflight = await req(
      "POST /auth/session (preflight)",
      "POST",
      "/auth/session",
      bootToken,
      { intendedRole: "consumer" },
    );
    if (!preflight.ok) {
      console.error(
        `\nPreflight dev-auth call failed (HTTP ${preflight.status}): ${JSON.stringify(preflight.data)}\n` +
          `This backend probably does not have DEV_AUTH_BYPASS=true set. ` +
          `Bulk-creating 1000 synthetic accounts requires it (no real phone/Google OTP at this scale). ` +
          `Enable DEV_AUTH_BYPASS on the target and re-run.`,
      );
      process.exitCode = 1;
      return;
    }

    log("Fetching catalog + shelf-life matrix ...");
    const [groups, shelf] = await Promise.all([
      buildGroups(bootToken),
      buildShelfMatrix(bootToken),
    ]);
    log(`Catalog groups usable for pairing: ${groups.length}`);

    log(`Starting ${COUNT} concurrent consumer↔supplier pipelines (HTTP concurrency=${CONCURRENCY}) ...`);
    const startedAt = Date.now();
    let done = 0;
    const results = await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        runPair(i, groups, shelf).then((r) => {
          done++;
          if (done % 50 === 0 || done === COUNT) {
            log(`  progress: ${done}/${COUNT} pairs finished`);
          }
          return r;
        }),
      ),
    );
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    const failures = results.filter((r) => r.error);
    log(`Pipelines complete in ${elapsedSec}s — ${results.length - failures.length} full loops OK, ${failures.length} failed partway.`);
    if (failures.length > 0) {
      console.log("\nFirst 10 failures:");
      for (const f of failures.slice(0, 10)) {
        console.log(`  #${f.i} (${f.consumerUserId} / ${f.supplierUserId}): ${f.error}`);
      }
    }

    printReport();

    if (SKIP_CLEANUP) {
      log("LOAD_SKIP_CLEANUP=1 — leaving created rows in place. Re-run with LOAD_CLEANUP_ONLY=1 to delete them later.");
    } else {
      await cleanupAll(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exitCode = 1;
});
