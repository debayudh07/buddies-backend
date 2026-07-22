import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError, assertFound } from '../../lib/errors';
import { sendPush } from '../../lib/notify';
import { uploadBuffer } from '../../lib/storage';
import { bumpReturnRate } from '../orders/service';

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
  const matrix = await prisma.shelfLifeMatrix.findMany({ orderBy: { productCategory: 'asc' } });
  res.json({ matrix });
});

const claimSchema = z.object({
  reasonCode: z.string(),
  productCategory: z.string(),
  lineItemIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

returnsRouter.post(
  '/orders/:id/return-claims',
  authenticate,
  requireRole('consumer'),
  validateBody(claimSchema),
  async (req, res) => {
    const order = assertFound(await prisma.order.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (order.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not your order');
    if (order.status !== 'delivered' && order.status !== 'closed') {
      throw new AppError(400, 'NOT_DELIVERED', 'Returns only after delivery');
    }
    if (CHANGE_OF_MIND.has(req.body.reasonCode)) {
      throw new AppError(400, 'CHANGE_OF_MIND_FORBIDDEN', 'Change of mind is not a valid return');
    }

    const window = await prisma.returnWindowMatrix.findUnique({
      where: { productCategory: req.body.productCategory },
    });
    const hours = window?.windowHours ?? 12;
    if (order.deliveredAt) {
      const elapsedH = (Date.now() - order.deliveredAt.getTime()) / 3600000;
      if (elapsedH > hours) {
        throw new AppError(400, 'RETURN_WINDOW_EXPIRED', `Window was ${hours}h for this category`);
      }
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
        windowDeadline: new Date(Date.now() + hours * 3600000),
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
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');

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

    const evidence = await prisma.returnEvidence.create({
      data: {
        claimId: claim.id,
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
      include: { evidence: true },
    }),
  );
  if (claim.consumerUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
  if (claim.windowDeadline < new Date()) {
    throw new AppError(400, 'RETURN_WINDOW_EXPIRED', 'Window expired');
  }
  if (claim.evidence.length === 0) {
    throw new AppError(400, 'EVIDENCE_REQUIRED', 'Upload photo/video evidence first');
  }

  // Simple auto-approve heuristic: reason codes that clearly implicate supplier
  const autoCodes = new Set(['thawed', 'cold_chain_break', 'expired', 'wrong_item', 'pest', 'leakage']);
  const auto = autoCodes.has(claim.reasonCode);

  const updated = await prisma.returnClaim.update({
    where: { id: claim.id },
    data: {
      status: auto ? 'auto_approved' : 'supplier_review',
      submittedAt: new Date(),
      decidedAt: auto ? new Date() : undefined,
      feeAllocation: auto ? 'supplier_bears_reverse' : 'none',
      mediatorNotes: auto ? 'Auto-approved: clear supplier fault signals' : undefined,
    },
  });

  if (auto) await bumpReturnRate(claim.supplierUserId, true);

  await sendPush({
    userId: claim.supplierUserId,
    title: auto ? 'Return auto-approved' : 'Return claim for review',
    body: claim.reasonCode,
    data: { claimId: claim.id },
  });

  res.json({ claim: updated });
});

returnsRouter.get('/me/return-claims', authenticate, async (req, res) => {
  const where =
    req.user!.role === 'supplier'
      ? { supplierUserId: req.user!.id }
      : { consumerUserId: req.user!.id };
  const claims = await prisma.returnClaim.findMany({
    where,
    include: { evidence: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ claims });
});

returnsRouter.get('/supplier/return-claims', authenticate, requireRole('supplier'), async (req, res) => {
  const claims = await prisma.returnClaim.findMany({
    where: { supplierUserId: req.user!.id, status: { in: ['supplier_review', 'submitted', 'auto_approved'] } },
    include: { evidence: true },
    orderBy: { createdAt: 'desc' },
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
    }),
  ),
  async (req, res) => {
    const claim = assertFound(await prisma.returnClaim.findUnique({ where: { id: requireParam(req, 'id') } }));
    if (claim.supplierUserId !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Not yours');
    if (claim.status !== 'supplier_review') {
      throw new AppError(400, 'INVALID_STATE', 'Not awaiting supplier review');
    }

    const accepted = req.body.decision === 'accept';
    const updated = await prisma.returnClaim.update({
      where: { id: claim.id },
      data: {
        status: accepted ? 'approved' : 'rejected',
        decidedAt: new Date(),
        feeAllocation: accepted ? 'supplier_bears_reverse' : 'none',
        mediatorNotes: req.body.notes,
      },
    });
    if (accepted) await bumpReturnRate(claim.supplierUserId, true);

    await sendPush({
      userId: claim.consumerUserId,
      title: accepted ? 'Return approved' : 'Return disputed/rejected',
      body: req.body.notes ?? req.body.decision,
      data: { claimId: claim.id },
    });

    res.json({ claim: updated });
  },
);

returnsRouter.get('/return-claims/:id', authenticate, async (req, res) => {
  const claim = assertFound(
    await prisma.returnClaim.findUnique({
      where: { id: requireParam(req, 'id') },
      include: { evidence: true },
    }),
  );
  if (claim.consumerUserId !== req.user!.id && claim.supplierUserId !== req.user!.id && req.user!.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Not yours');
  }
  res.json({ claim });
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
