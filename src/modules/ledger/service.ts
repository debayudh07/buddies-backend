import { prisma } from '../../lib/prisma';
import { publicSupplierLabel, sanitizeLabel } from '../../lib/user-present';

export type LedgerKind = 'all' | 'delivery' | 'payment' | 'return';

export type LedgerEntryKind = 'delivery' | 'payment' | 'return' | 'replacement';

export type LedgerEntry = {
  at: string;
  kind: LedgerEntryKind;
  orderId: string;
  orderCode: string;
  returnId: string | null;
  invoiceNumber: string | null;
  partyId: string;
  partyLabel: string;
  particular: string;
  /** Positive raises still-due; negative lowers it. */
  signedPaise: number;
  /** Kept for older clients; apps show signedPaise instead. */
  debitPaise: number;
  creditPaise: number;
  /** Running still-due after this line (full history walk). */
  balancePaise: number;
};

export type LedgerParty = {
  id: string;
  label: string;
  /** Closing due for the selected window. */
  duePaise: number;
  lastAt: string | null;
};

export type LedgerOpenOrder = {
  orderId: string;
  orderCode: string;
  status: string;
  partyLabel: string;
  amountPaise: number;
};

export type LedgerSummary = {
  /** Still due just before `from`. */
  openingDuePaise: number;
  billedPaise: number;
  settledPaise: number;
  refundedPaise: number;
  /** opening + billed − settled − refunded (same window). */
  duePaise: number;
  openCount: number;
};

export type LedgerResult = {
  summary: LedgerSummary;
  parties: LedgerParty[];
  open: LedgerOpenOrder[];
  entries: LedgerEntry[];
};

const DELIVERED_STATUSES = new Set([
  'delivered',
  'challan_signed',
  'closed',
]);

const OPEN_STATUSES = new Set([
  'placed',
  'bid_accepted',
  'preparing',
  'out_for_delivery',
  'arrived',
  'inspection_pending',
]);

const ENTRY_CAP = 500;

type RawLine = {
  at: Date;
  kind: LedgerEntryKind;
  orderId: string;
  orderCode: string;
  returnId: string | null;
  invoiceNumber: string | null;
  partyId: string;
  partyLabel: string;
  particular: string;
  /** Positive amount that increases "still due" for this viewer. */
  dueDeltaPaise: number;
  debitPaise: number;
  creditPaise: number;
};

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function parseDate(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return fallback;
  return new Date(t);
}

function partyLabelFor(
  role: 'supplier' | 'consumer',
  order: {
    consumerUserId: string;
    supplierUserId: string;
    bid?: {
      supplier?: {
        publicLabel?: string | null;
        businessName?: string | null;
      } | null;
    } | null;
  },
  consumerName: string | null,
): { id: string; label: string } {
  if (role === 'supplier') {
    return {
      id: order.consumerUserId,
      label: sanitizeLabel(consumerName) ?? 'Restaurant',
    };
  }
  return {
    id: order.supplierUserId,
    label: publicSupplierLabel(order.bid?.supplier),
  };
}

/**
 * Build a read-only account book for one user.
 * Positive balance = still due (supplier to collect / restaurant to pay).
 *
 * Identity for the selected window:
 *   closingDue = openingDue + billed − collected − refunded
 */
export async function buildLedger(opts: {
  userId: string;
  role: 'supplier' | 'consumer' | 'admin';
  from?: string;
  to?: string;
  kind?: LedgerKind;
  counterpartyId?: string;
}): Promise<LedgerResult> {
  const role = opts.role === 'admin' ? 'supplier' : opts.role;
  const now = new Date();
  const from = parseDate(opts.from, startOfMonth(now));
  const to = parseDate(opts.to, endOfDay(now));
  const kindFilter = opts.kind ?? 'all';
  const counterpartyId = opts.counterpartyId?.trim() || null;

  const where =
    role === 'supplier'
      ? {
          supplierUserId: opts.userId,
          ...(counterpartyId ? { consumerUserId: counterpartyId } : {}),
        }
      : {
          consumerUserId: opts.userId,
          ...(counterpartyId ? { supplierUserId: counterpartyId } : {}),
        };

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: 2_000,
    select: {
      id: true,
      orderCode: true,
      status: true,
      consumerUserId: true,
      supplierUserId: true,
      deliveredAt: true,
      createdAt: true,
      updatedAt: true,
      bid: {
        select: {
          amountPaise: true,
          supplier: {
            select: { publicLabel: true, businessName: true, userId: true },
          },
        },
      },
      offlinePayment: {
        select: { status: true, confirmedAt: true, updatedAt: true },
      },
      gstInvoice: { select: { invoiceNumber: true } },
      returnClaims: {
        select: {
          id: true,
          status: true,
          resolutionType: true,
          refundAmountPaise: true,
          refundReceivedAt: true,
          closedAt: true,
          replacedAt: true,
          decidedAt: true,
          updatedAt: true,
        },
      },
    },
  });

  const consumerIds = [...new Set(orders.map((o) => o.consumerUserId))];
  const consumerProfiles =
    role === 'supplier' && consumerIds.length > 0
      ? await prisma.consumerProfile.findMany({
          where: { userId: { in: consumerIds } },
          select: { userId: true, restaurantName: true },
        })
      : [];
  const consumerNameByUser = new Map(
    consumerProfiles.map((p) => [p.userId, p.restaurantName ?? null]),
  );

  const open: LedgerOpenOrder[] = [];
  const allLines: RawLine[] = [];

  for (const order of orders) {
    const amountPaise = order.bid?.amountPaise ?? 0;
    const party = partyLabelFor(
      role,
      order,
      consumerNameByUser.get(order.consumerUserId) ?? null,
    );
    const invoiceNumber = order.gstInvoice?.invoiceNumber ?? null;

    if (OPEN_STATUSES.has(order.status)) {
      open.push({
        orderId: order.id,
        orderCode: order.orderCode,
        status: order.status,
        partyLabel: party.label,
        amountPaise,
      });
    }

    if (DELIVERED_STATUSES.has(order.status) && amountPaise > 0) {
      const at = order.deliveredAt ?? order.updatedAt ?? order.createdAt;
      const debitPaise = role === 'consumer' ? amountPaise : 0;
      const creditPaise = role === 'supplier' ? amountPaise : 0;
      allLines.push({
        at,
        kind: 'delivery',
        orderId: order.id,
        orderCode: order.orderCode,
        returnId: null,
        invoiceNumber,
        partyId: party.id,
        partyLabel: party.label,
        particular: `Delivery · ${order.orderCode}`,
        dueDeltaPaise: amountPaise,
        debitPaise,
        creditPaise,
      });
    }

    const pay = order.offlinePayment;
    if (pay?.status === 'confirmed_by_supplier' && amountPaise > 0) {
      const at = pay.confirmedAt ?? pay.updatedAt ?? order.updatedAt;
      const debitPaise = role === 'supplier' ? amountPaise : 0;
      const creditPaise = role === 'consumer' ? amountPaise : 0;
      allLines.push({
        at,
        kind: 'payment',
        orderId: order.id,
        orderCode: order.orderCode,
        returnId: null,
        invoiceNumber,
        partyId: party.id,
        partyLabel: party.label,
        particular:
          role === 'supplier'
            ? `Payment received · ${order.orderCode}`
            : `Paid · ${order.orderCode}`,
        dueDeltaPaise: -amountPaise,
        debitPaise,
        creditPaise,
      });
    }

    for (const claim of order.returnClaims) {
      const isRefund =
        (claim.status === 'refunded' || claim.status === 'closed') &&
        claim.resolutionType === 'refund' &&
        (claim.refundAmountPaise ?? 0) > 0;
      const isReplacement =
        (claim.status === 'replaced' || claim.status === 'closed') &&
        claim.resolutionType === 'replacement';

      if (isRefund) {
        const amt = claim.refundAmountPaise ?? 0;
        const at =
          claim.refundReceivedAt ??
          claim.closedAt ??
          claim.decidedAt ??
          claim.updatedAt;
        const debitPaise = role === 'supplier' ? amt : 0;
        const creditPaise = role === 'consumer' ? amt : 0;
        allLines.push({
          at,
          kind: 'return',
          orderId: order.id,
          orderCode: order.orderCode,
          returnId: claim.id,
          invoiceNumber,
          partyId: party.id,
          partyLabel: party.label,
          particular: `Refund · ${order.orderCode}`,
          dueDeltaPaise: -amt,
          debitPaise,
          creditPaise,
        });
      } else if (isReplacement) {
        const at =
          claim.replacedAt ?? claim.closedAt ?? claim.decidedAt ?? claim.updatedAt;
        allLines.push({
          at,
          kind: 'replacement',
          orderId: order.id,
          orderCode: order.orderCode,
          returnId: claim.id,
          invoiceNumber,
          partyId: party.id,
          partyLabel: party.label,
          particular: `Replacement · ${order.orderCode}`,
          dueDeltaPaise: 0,
          debitPaise: 0,
          creditPaise: 0,
        });
      }
    }
  }

  allLines.sort((a, b) => {
    const t = a.at.getTime() - b.at.getTime();
    if (t !== 0) return t;
    return a.orderCode.localeCompare(b.orderCode);
  });

  // Full walk: opening is the balance just before `from`.
  // Summary totals always count every kind in the window (kind filter only
  // hides rows; it must not punch holes in the balance).
  let running = 0;
  let openingDuePaise = 0;
  let billedPaise = 0;
  let settledPaise = 0;
  let refundedPaise = 0;
  const windowed: LedgerEntry[] = [];
  const partyClosing = new Map<string, number>();
  const partyMeta = new Map<string, { label: string; lastAt: Date | null }>();
  let openingCaptured = false;

  for (const line of allLines) {
    const before = running;
    running += line.dueDeltaPaise;
    const inWindow =
      line.at.getTime() >= from.getTime() && line.at.getTime() <= to.getTime();

    if (!openingCaptured && line.at.getTime() >= from.getTime()) {
      openingDuePaise = before;
      openingCaptured = true;
    }

    // Party closing due for the window: balance after the last in-window line,
    // or opening if the party had no activity in the window.
    if (inWindow) {
      partyClosing.set(line.partyId, running);
      const meta = partyMeta.get(line.partyId);
      if (!meta || (meta.lastAt?.getTime() ?? 0) < line.at.getTime()) {
        partyMeta.set(line.partyId, {
          label: line.partyLabel,
          lastAt: line.at,
        });
      }

      if (line.kind === 'delivery') billedPaise += Math.abs(line.dueDeltaPaise);
      if (line.kind === 'payment') settledPaise += Math.abs(line.dueDeltaPaise);
      if (line.kind === 'return') refundedPaise += Math.abs(line.dueDeltaPaise);

      const kindOk =
        kindFilter === 'all' ||
        (kindFilter === 'delivery' && line.kind === 'delivery') ||
        (kindFilter === 'payment' && line.kind === 'payment') ||
        (kindFilter === 'return' &&
          (line.kind === 'return' || line.kind === 'replacement'));

      if (kindOk) {
        windowed.push({
          at: line.at.toISOString(),
          kind: line.kind,
          orderId: line.orderId,
          orderCode: line.orderCode,
          returnId: line.returnId,
          invoiceNumber: line.invoiceNumber,
          partyId: line.partyId,
          partyLabel: line.partyLabel,
          particular: line.particular,
          signedPaise: line.dueDeltaPaise,
          debitPaise: line.debitPaise,
          creditPaise: line.creditPaise,
          balancePaise: running,
        });
      }
    } else if (line.at.getTime() < from.getTime()) {
      // Seed party closing with pre-window balance so parties with no
      // in-window activity still show their opening as closing.
      partyClosing.set(line.partyId, running);
      if (!partyMeta.has(line.partyId)) {
        partyMeta.set(line.partyId, {
          label: line.partyLabel,
          lastAt: line.at,
        });
      }
    }
  }

  // No lines at all after `from` — opening is the final running balance.
  if (!openingCaptured) {
    openingDuePaise = running;
  }

  const closingDuePaise =
    openingDuePaise + billedPaise - settledPaise - refundedPaise;

  const entries =
    windowed.length > ENTRY_CAP
      ? windowed.slice(windowed.length - ENTRY_CAP)
      : windowed;

  const parties: LedgerParty[] = [...partyClosing.entries()]
    .map(([id, due]) => ({
      id,
      label: partyMeta.get(id)?.label ?? 'Party',
      duePaise: due,
      lastAt: partyMeta.get(id)?.lastAt?.toISOString() ?? null,
    }))
    .filter((p) => p.duePaise !== 0 || (p.lastAt != null &&
      // Keep parties that had activity in the window even if they closed to zero.
      (() => {
        try {
          const t = Date.parse(p.lastAt!);
          return t >= from.getTime() && t <= to.getTime();
        } catch {
          return false;
        }
      })()))
    .sort((a, b) => Math.abs(b.duePaise) - Math.abs(a.duePaise));

  return {
    summary: {
      openingDuePaise,
      billedPaise,
      settledPaise,
      refundedPaise,
      duePaise: closingDuePaise,
      openCount: open.length,
    },
    parties,
    open: open.slice(0, 20),
    entries,
  };
}
