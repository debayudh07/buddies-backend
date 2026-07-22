import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/errors';

export const kycRouter = Router();

const kycSchema = z.object({
  businessName: z.string().min(1),
  ownerName: z.string().min(1),
  ownerPhone: z.string().min(8),
  gstin: z.string().optional(),
  aadhaarRef: z.string().optional(),
  shopAddressPrivate: z.string().min(1),
  publicLabel: z.string().min(1),
  lat: z.number().optional(),
  lng: z.number().optional(),
  categories: z.array(z.string()).optional(),
});

kycRouter.get('/supplier/kyc', authenticate, requireRole('supplier'), async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
  res.json({ profile });
});

kycRouter.post(
  '/supplier/kyc',
  authenticate,
  requireRole('supplier'),
  validateBody(kycSchema),
  async (req, res) => {
    const data = req.body as z.infer<typeof kycSchema>;
    const profile = await prisma.supplierProfile.upsert({
      where: { userId: req.user!.id },
      create: {
        userId: req.user!.id,
        ...data,
        categories: data.categories ?? [],
        kycStatus: 'draft',
      },
      update: {
        ...data,
        categories: data.categories ?? undefined,
      },
    });
    res.json({ profile });
  },
);

kycRouter.post('/supplier/kyc/submit', authenticate, requireRole('supplier'), async (req, res) => {
  const existing = await prisma.supplierProfile.findUnique({ where: { userId: req.user!.id } });
  if (!existing) throw new AppError(400, 'NO_KYC', 'Complete KYC form first');
  const profile = await prisma.supplierProfile.update({
    where: { userId: req.user!.id },
    data: { kycStatus: 'submitted' },
  });
  res.json({ profile });
});

/** Admin / ops: verify supplier for Bidzone access */
kycRouter.post(
  '/admin/supplier/:userId/verify',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    const profile = await prisma.supplierProfile.update({
      where: { userId: requireParam(req, 'userId') },
      data: { kycStatus: 'verified' },
    });
    res.json({ profile });
  },
);

kycRouter.post(
  '/admin/supplier/:userId/reject',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    const profile = await prisma.supplierProfile.update({
      where: { userId: requireParam(req, 'userId') },
      data: { kycStatus: 'rejected' },
    });
    res.json({ profile });
  },
);

/** Dev helper: self-verify when DEV_AUTH_BYPASS */
kycRouter.post('/supplier/kyc/dev-verify', authenticate, requireRole('supplier'), async (req, res) => {
  if (process.env.DEV_AUTH_BYPASS !== 'true') {
    throw new AppError(403, 'FORBIDDEN', 'Only available in DEV_AUTH_BYPASS mode');
  }
  const profile = await prisma.supplierProfile.update({
    where: { userId: req.user!.id },
    data: { kycStatus: 'verified' },
  });
  res.json({ profile });
});
