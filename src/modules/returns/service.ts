import type { Prisma, ReturnClaim, ReturnClaimStatus, ReturnResolution } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { emitReturn, emitUser } from '../../socket';
import { sendPush } from '../../lib/notify';
import { bumpReturnRate } from '../orders/service';

const claimInclude = {
  evidence: true,
  order: {
    select: {
      id: true,
      orderCode: true,
      status: true,
      deliveryAddress: true,
      bid: { select: { amountPaise: true } },
      bidRequest: { include: { items: true } },
    },
  },
} as const;

export type ClaimWithRelations = Prisma.ReturnClaimGetPayload<{ include: typeof claimInclude }>;

function requireStatus(claim: ReturnClaim, allowed: ReturnClaimStatus[], action: string) {
  if (!allowed.includes(claim.status)) {
    throw new AppError(
      400,
      'INVALID_STATE',
      `Cannot ${action} from status ${claim.status}`,
    );
  }
}

export async function loadClaim(id: string) {
  return prisma.returnClaim.findUnique({
    where: { id },
    include: claimInclude,
  });
}

export async function broadcastClaim(claim: ReturnClaim, title: string, body: string, toUserId: string) {
  const payload = { claim };
  emitReturn(claim.id, 'return.updated', payload);
  emitUser(claim.consumerUserId, 'return.updated', payload);
  emitUser(claim.supplierUserId, 'return.updated', payload);
  void sendPush({
    userId: toUserId,
    title,
    body,
    data: { claimId: claim.id },
  }).catch(() => undefined);
}

export async function applySupplierDecision(
  claim: ReturnClaim,
  input: {
    decision: 'accept' | 'dispute';
    notes?: string;
    resolutionType?: ReturnResolution;
    refundAmountPaise?: number;
    pickupWindow?: string;
  },
) {
  requireStatus(claim, ['supplier_review'], 'decide');
  const accepted = input.decision === 'accept';
  const resolutionType = accepted ? (input.resolutionType ?? 'refund') : undefined;
  const pickupWindow = accepted ? input.pickupWindow?.trim() : undefined;
  const nextStatus: ReturnClaimStatus =
    accepted && pickupWindow ? 'pickup_scheduled' : accepted ? 'approved' : 'rejected';

  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: nextStatus,
      decidedAt: new Date(),
      feeAllocation: accepted ? 'supplier_bears_reverse' : 'none',
      mediatorNotes: input.notes,
      resolutionType: resolutionType ?? null,
      refundAmountPaise: accepted ? input.refundAmountPaise ?? null : null,
      pickupWindow: pickupWindow || null,
      pickupScheduledAt: nextStatus === 'pickup_scheduled' ? new Date() : null,
    },
    include: claimInclude,
  });
  if (accepted) await bumpReturnRate(claim.supplierUserId, true);
  await broadcastClaim(
    updated,
    accepted ? 'Return approved' : 'Return disputed/rejected',
    input.notes ?? input.decision,
    claim.consumerUserId,
  );
  return updated;
}

export async function schedulePickup(claim: ReturnClaim, pickupWindow: string) {
  requireStatus(claim, ['approved', 'pickup_scheduled'], 'schedule pickup');
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'pickup_scheduled',
      pickupWindow,
      pickupScheduledAt: new Date(),
    },
    include: claimInclude,
  });
  await broadcastClaim(
    updated,
    'Pickup scheduled',
    pickupWindow,
    claim.consumerUserId,
  );
  return updated;
}

export async function confirmPickup(claim: ReturnClaim) {
  requireStatus(claim, ['approved', 'pickup_scheduled'], 'confirm pickup');
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'picked_up',
      pickedUpAt: new Date(),
    },
    include: claimInclude,
  });
  await broadcastClaim(updated, 'Item picked up', 'The supplier collected the return', claim.consumerUserId);
  return updated;
}

export async function recordRefund(
  claim: ReturnClaim,
  input: { amountPaise: number; receiptRef?: string },
) {
  requireStatus(claim, ['picked_up'], 'record refund');
  if (claim.resolutionType === 'replacement') {
    throw new AppError(400, 'INVALID_STATE', 'This claim is a replacement, not a refund');
  }
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'refunded',
      resolutionType: 'refund',
      refundAmountPaise: input.amountPaise,
      refundReceiptRef: input.receiptRef ?? null,
      refundReceivedAt: new Date(),
    },
    include: claimInclude,
  });
  await broadcastClaim(
    updated,
    'Refund handed over',
    `₹${Math.round(input.amountPaise / 100)} recorded. Confirm when you have it.`,
    claim.consumerUserId,
  );
  return updated;
}

export async function confirmReplaced(claim: ReturnClaim) {
  requireStatus(claim, ['picked_up'], 'confirm replacement');
  if (claim.resolutionType === 'refund') {
    throw new AppError(400, 'INVALID_STATE', 'This claim is a refund, not a replacement');
  }
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'replaced',
      resolutionType: 'replacement',
      replacedAt: new Date(),
    },
    include: claimInclude,
  });
  await broadcastClaim(
    updated,
    'Replacement delivered',
    'Confirm when you have the new item',
    claim.consumerUserId,
  );
  return updated;
}

export async function consumerAck(claim: ReturnClaim) {
  requireStatus(claim, ['refunded', 'replaced', 'rejected'], 'acknowledge');
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'closed',
      closedAt: new Date(),
    },
    include: claimInclude,
  });
  await broadcastClaim(updated, 'Return closed', 'The consumer confirmed the outcome', claim.supplierUserId);
  return updated;
}

export async function emitSubmitted(claim: ReturnClaim) {
  await broadcastClaim(claim, 'Return claim for review', claim.reasonCode, claim.supplierUserId);
}
