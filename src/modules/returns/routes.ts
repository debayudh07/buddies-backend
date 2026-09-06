import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { uploadBuffer } from '../../lib/storage';
import {
  applySupplierDecision,
  consumerAck,
  confirmPickup,
  confirmReplaced,
  emitSubmitted,
  recordRefund,
  schedulePickup,
} from './service';

export const returnsRouter = Router();

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

const CHANGE_OF_MIND = new Set(['change_of_mind', 'over_order', 'menu_change', 'slow_business']);

returnsRouter.get('/returns/policy', authenticate, async (_req, res) => {
  res.json({
    policy: {
      onSpot: 'Reject before digital challan sign for RSL fail, tamper, leakage, short qty, cold-chain break',
      afterSign: 'No visible-damage returns after challan signed',
      hiddenDefects: 'Category windows 1h–48h with mandatory media',
      changeOfMind: 'Forbidden',
      fees: {
        supplierFault: 'supplier_bears_reverse',
        badFaithReject: 'consumer_restocking_15pct',
      },
    },
  });
});

returnsRouter.get('/returns/windows', authenticate, async (_req, res) => {
  const windows = await prisma.returnWindowMatrix.findMany({ orderBy: { productCategory: 'asc' } });
  res.json({ windows });
});

returnsRouter.get('/catalog/shelf-life-matrix', authenticate, async (_req, res) => {
  const { PRODUCT_CATEGORIES, getCategoryDef } = await import('../../lib/product-categories');
  const matrix = await prisma.shelfLifeMatrix.findMany({ orderBy: { productCategory: 'asc' } });
  // Prefer DB rows (seeded); if empty, fall back to product-doc constants.
  if (matrix.length === 0) {
    res.json({
      matrix: PRODUCT_CATEGORIES.map((c) => ({
        productCategory: c.productCategory,
        subCategory: c.exampleItems,
        totalShelfLifeDays: c.totalShelfLifeDays,
        minRslDays: c.minRslDays,
        notes: c.notes,
        windowHours: c.windowHours,
        label: c.label,
      })),
    });
    return;
  }
  res.json({
    matrix: matrix.map((m) => {
      const def = getCategoryDef(m.productCategory);
      return {
        ...m,
        label: def?.label ?? m.productCategory,
        windowHours: def?.windowHours ?? null,
      };
    }),
  });
});

returnsRouter.get('/catalog/product-categories', authenticate, async (_req, res) => {
  const { PRODUCT_CATEGORIES } = await import('../../lib/product-categories');
  res.json({
    categories: PRODUCT_CATEGORIES.map((c) => ({
      productCategory: c.productCategory,
      label: c.label,
      exampleItems: c.exampleItems,
      totalShelfLifeDays: c.totalShelfLifeDays,
      minRslDays: c.minRslDays,
      windowHours: c.windowHours,
      notes: c.notes,
    })),
  });
});

const claimSchema = z.object({
  reasonCode: z.string(),
  productCategory: z.string(),
  lineItemIds: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});

type ReturnableOrderItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  productCategory: string | null;
  packSize?: string | null;
};

function allowedReturnItems(order: {
  coveredItemIds?: string[] | null;
  bidRequest?: { items?: ReturnableOrderItem[] | null } | null;
}): ReturnableOrderItem[] {
  const raw = order.bidRequest?.items ?? [];
  const covered = order.coveredItemIds ?? [];
  return covered.length > 0 ? raw.filter((i) => covered.includes(i.id)) : raw;
}

returnsRouter.post(
  '/orders/:id/return-claims',
  authenticate,
  requireRole('consumer'),
  validateBody(claimSchema),
  async (req, res) => {
    const order = assertFound(
      await prisma.order.findUnique({
        where: { id: requireParam(req, 'id') },
        include: {
          bidRequest: {
            select: {
              items: {
                select: {
                  id: true,
                  name: true,
                  quantity: true,
                  unit: true,
                  productCategory: true,
                  packSize: true,
                },
              },
            },
          },
        },
      }),
    );
    if (order.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not your order');
    if (order.status !== 'delivered' && order.status !== 'closed') {
      throw new AppError(400, 'NOT_DELIVERED', 'Returns only after delivery');
    }
    if (CHANGE_OF_MIND.has(req.body.reasonCode)) {
      throw new AppError(400, 'CHANGE_OF_MIND_FORBIDDEN', 'Change of mind is not a valid return');
    }

    const lineItemIds = req.body.lineItemIds as string[];
    const allowed = allowedReturnItems(order);
    const allowedIds = new Set(allowed.map((i) => i.id));
    if (lineItemIds.some((id) => !allowedIds.has(id))) {
      throw new AppError(400, 'INVALID_LINE_ITEMS', 'Return items must belong to this order');
    }
    const selected = allowed.filter((i) => lineItemIds.includes(i.id));
    const selectedCats = new Set(
      selected.map((i) => i.productCategory).filter((c): c is string => !!c && c.trim().length > 0),
    );
    if (selectedCats.size !== 1 || !selectedCats.has(req.body.productCategory)) {
      throw new AppError(
        400,
        'ORDER_CATEGORY_MISMATCH',
        'Product category must match the selected order items — one category per claim',
      );
    }

    const window = await prisma.returnWindowMatrix.findUnique({
      where: { productCategory: req.body.productCategory },
    });
    if (!window) {
      throw new AppError(
        400,
        'UNKNOWN_CATEGORY',
        'Unknown product category — pick one from the return windows list',
      );
    }
    if (window.validReasons.length > 0 && !window.validReasons.includes(req.body.reasonCode)) {
      // Allow clear supplier-fault auto codes even if not listed for the category.
      const autoCodes = new Set(['thawed', 'cold_chain_break', 'expired', 'wrong_item', 'pest', 'leakage']);
      if (!autoCodes.has(req.body.reasonCode)) {
        throw new AppError(
          400,
          'INVALID_REASON',
          `Reason not valid for ${req.body.productCategory}. Allowed: ${window.validReasons.join(', ')}`,
        );
      }
    }
    const hours = window.windowHours;
    if (!order.deliveredAt) {
      throw new AppError(
        400,
        'NOT_DELIVERED',
        'Returns require a recorded delivery time (sign challan first)',
      );
    }
    // Absolute deadline from delivery — never extend from "now" on draft create.
    const windowDeadline = new Date(
      order.deliveredAt.getTime() + hours * 3_600_000,
    );
    if (Date.now() > windowDeadline.getTime()) {
      throw new AppError(
        400,
        'RETURN_WINDOW_EXPIRED',
        `Return window was ${hours}h after delivery and is closed`,
      );
    }

    // An item that already has an active or successfully-resolved claim can't be
    // claimed again — only a fully rejected prior claim allows a retry.
    const priorClaims = await prisma.returnClaim.findMany({
      where: { orderId: order.id, lineItemIds: { hasSome: lineItemIds } },
      select: { status: true },
    });
    if (priorClaims.some((c) => c.status !== 'rejected')) {
      throw new AppError(
        400,
        'ALREADY_RETURNED',
        'One or more of these items already has an active or completed return claim',
      );
    }

    const claim = await prisma.returnClaim.create({
      data: {
        orderId: order.id,
        consumerUserId: order.consumerUserId,
        supplierUserId: order.supplierUserId,
        reasonCode: req.body.reasonCode,
        productCategory: req.body.productCategory,
        lineItemIds: req.body.lineItemIds,
        notes: req.body.notes,
        windowDeadline,
        status: 'draft',
      },
    });
    res.status(201).json({ claim });
  },
);

returnsRouter.post(
  '/return-claims/:id/evidence',
  authenticate,
  requireRole('consumer'),
  (req, res, next) => {
    evidenceUpload.single('file')(req, res, (err) => {
      if (err) {
        return next(
          new AppError(400, 'UPLOAD_ERROR', err instanceof Error ? err.message : 'Upload failed'),
        );
      }
      return next();
    });
  },
  async (req, res) => {
    const claim = assertFound(
      await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }),
    );
    if (claim.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    if (claim.status !== 'draft') {
      throw new AppError(400, 'INVALID_STATE', 'Evidence can only be added to draft claims');
    }
    if (claim.windowDeadline < new Date()) {
      throw new AppError(400, 'RETURN_WINDOW_EXPIRED', 'Return window is closed — cannot add evidence');
    }

    let storageRef = typeof req.body.storageRef === 'string' ? req.body.storageRef : '';
    let mediaType = typeof req.body.mediaType === 'string' ? req.body.mediaType : '';

    if (req.file) {
      const stored = await uploadBuffer({
        purpose: 'returns',
        userId: req.user!.id,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname || 'evidence.bin',
      });
      storageRef = stored.storageRef;
      mediaType = stored.mediaType;
    }

    if (!storageRef || !mediaType) {
      throw new AppError(
        400,
        'EVIDENCE_MEDIA_REQUIRED',
        'Provide multipart file OR JSON storageRef + mediaType',
      );
    }

    const lineItemIdRaw =
      typeof req.body.lineItemId === 'string' ? req.body.lineItemId.trim() : '';
    if (!lineItemIdRaw || !claim.lineItemIds.includes(lineItemIdRaw)) {
      throw new AppError(
        400,
        'INVALID_LINE_ITEM',
        'Photo must be tagged to an item on this return',
      );
    }
    const lineItemId = lineItemIdRaw;

    const evidence = await prisma.returnEvidence.create({
      data: {
        claimId: claim.id,
        lineItemId,
        storageRef,
        mediaType,
        batchNumber: req.body.batchNumber,
        expiryDate: req.body.expiryDate,
        defectNote: req.body.defectNote,
      },
    });
    res.status(201).json({ evidence });
  },
);

returnsRouter.post('/return-claims/:id/submit', authenticate, requireRole('consumer'), async (req, res) => {
  const claim = assertFound(
    await prisma.returnClaim.findUnique({
      where: { id: requireParam(req, 'id') },
      include: {
        evidence: true,
        order: { select: { deliveredAt: true } },
      },
    }),
  );
  if (claim.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
  if (claim.status !== 'draft') {
    throw new AppError(400, 'INVALID_STATE', 'Only draft claims can be submitted');
  }

  // Re-check absolute delivery window (fixes old drafts that used now+hours).
  let deadline = claim.windowDeadline;
  const window = await prisma.returnWindowMatrix.findUnique({
    where: { productCategory: claim.productCategory },
  });
  if (claim.order.deliveredAt && window) {
    deadline = new Date(
      claim.order.deliveredAt.getTime() + window.windowHours * 3_600_000,
    );
    if (deadline.getTime() !== claim.windowDeadline.getTime()) {
      await prisma.returnClaim.update({
        where: { id: claim.id },
        data: { windowDeadline: deadline },
      });
    }
  }
  if (deadline < new Date()) {
    throw new AppError(
      400,
      'RETURN_WINDOW_EXPIRED',
      'Return window is closed — you can no longer submit this claim',
    );
  }
  if (claim.evidence.length === 0) {
    throw new AppError(400, 'EVIDENCE_REQUIRED', 'Upload photo/video evidence first');
  }
  const evidencedLines = new Set(
    claim.evidence.map((e) => e.lineItemId).filter((id): id is string => !!id && id.length > 0),
  );
  const missingPhoto = claim.lineItemIds.filter((id) => !evidencedLines.has(id));
  if (missingPhoto.length > 0) {
    throw new AppError(
      400,
      'ITEM_EVIDENCE_REQUIRED',
      'Add at least one photo for each selected item',
    );
  }

  // All submitted claims go to the supplier for review (no auto-approve).
  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: 'supplier_review',
      submittedAt: new Date(),
      feeAllocation: 'none',
      windowDeadline: deadline,
    },
  });

  await emitSubmitted(updated);

  res.json({ claim: updated });
});

returnsRouter.get('/me/return-claims', authenticate, async (req, res) => {
  const where =
    req.user!.role === 'supplier'
      ? { supplierUserId: req.user!.id }
      : { consumerUserId: req.user!.id };
  const take = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '40'), 10) || 40, 1),
    100,
  );
  const claims = await prisma.returnClaim.findMany({
    where,
    include: {
      evidence: true,
      order: { select: { id: true, orderCode: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ claims });
});

returnsRouter.get('/supplier/return-claims', authenticate, requireRole('supplier'), async (req, res) => {
  // Full supplier history — UI filters "needs action" vs decided.
  const take = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '40'), 10) || 40, 1),
    100,
  );
  const claims = await prisma.returnClaim.findMany({
    where: {
      supplierUserId: req.user!.id,
      status: {
        in: [
          'supplier_review',
          'submitted',
          'auto_approved',
          'approved',
          'rejected',
          'pickup_scheduled',
          'picked_up',
          'refunded',
          'replaced',
          'closed',
        ],
      },
    },
    include: {
      evidence: true,
      order: { select: { id: true, orderCode: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });
  res.json({ claims });
});

returnsRouter.post(
  '/return-claims/:id/supplier-decision',
  authenticate,
  requireRole('supplier'),
  validateBody(
    z.object({
      decision: z.enum(['accept', 'dispute']),
      coldChainLogRef: z.string().optional(),
      notes: z.string().optional(),
      resolutionType: z.enum(['refund', 'replacement']).optional(),
      refundAmountPaise: z.number().int().positive().optional(),
      pickupWindow: z.string().min(1).optional(),
    }),
  ),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await applySupplierDecision(claim, req.body);
    res.json({ claim: updated });
  },
);

returnsRouter.post(
  '/return-claims/:id/schedule-pickup',
  authenticate,
  requireRole('supplier'),
  validateBody(z.object({ pickupWindow: z.string().min(1) })),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await schedulePickup(claim, req.body.pickupWindow);
    res.json({ claim: updated });
  },
);

returnsRouter.post(
  '/return-claims/:id/confirm-pickup',
  authenticate,
  requireRole('supplier'),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await confirmPickup(claim);
    res.json({ claim: updated });
  },
);

returnsRouter.post(
  '/return-claims/:id/refund',
  authenticate,
  requireRole('supplier'),
  validateBody(
    z.object({
      amountPaise: z.number().int().positive(),
      receiptRef: z.string().optional(),
    }),
  ),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await recordRefund(claim, req.body);
    res.json({ claim: updated });
  },
);

returnsRouter.post(
  '/return-claims/:id/replaced',
  authenticate,
  requireRole('supplier'),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await confirmReplaced(claim);
    res.json({ claim: updated });
  },
);

returnsRouter.post(
  '/return-claims/:id/consumer-ack',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    const updated = await consumerAck(claim);
    res.json({ claim: updated });
  },
);

returnsRouter.get('/return-claims/:id', authenticate, async (req, res) => {
  const claim = assertFound(
    await prisma.returnClaim.findUnique({
      where: { id: requireParam(req, 'id') },
      include: {
        evidence: true,
        order: {
          select: {
            id: true,
            orderCode: true,
            status: true,
            deliveryAddress: true,
            coveredItemIds: true,
            bid: { select: { amountPaise: true } },
            bidRequest: { include: { items: true } },
            digitalChallan: {
              select: { lineSnapshotJson: true, signedAt: true, isDraft: true },
            },
          },
        },
      },
    }),
  );
  if (claim.consumerUserId !== req.user!.id && claim.supplierUserId !== req.user!.id && req.user!.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Not yours');
  }
  const items = allowedReturnItems(claim.order).filter((i) => claim.lineItemIds.includes(i.id));
  const itemsWithPhotos = items.map((item) => ({
    ...item,
    evidence: claim.evidence.filter((e) => e.lineItemId === item.id),
  }));
  res.json({ claim: { ...claim, items: itemsWithPhotos } });
});

returnsRouter.get('/orders/:id/return-claims', authenticate, async (req, res) => {
  const order = assertFound(await prisma.order.findUnique({ where: { id: requireParam(req, 'id') } }));
  if (order.consumerUserId !== req.user!.id && order.supplierUserId !== req.user!.id) {
    throw new AppError(403, 'FORBIDDEN', 'Not yours');
  }
  const claims = await prisma.returnClaim.findMany({
    where: { orderId: order.id },
    include: { evidence: true },
  });
  res.json({ claims });
});
