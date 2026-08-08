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
  gstin: z.string().optional().nullable(),
  aadhaarRef: z.string().optional().nullable(),
  /** Client may send shop/doc upload as docRef — stored on aadhaarRef when needed. */
  docRef: z.string().optional().nullable(),
  shopAddressPrivate: z.string().min(1),
  publicLabel: z.string().min(1),
  lat: z.number().finite().optional().nullable(),
  lng: z.number().finite().optional().nullable(),
  categories: z.array(z.string()).optional(),
});

function toProfileData(data: z.infer<typeof kycSchema>) {
  const aadhaarRef = data.aadhaarRef || data.docRef || null;
  const gstin = data.gstin?.trim() ? data.gstin.trim() : null;
  return {
    businessName: data.businessName.trim(),
    ownerName: data.ownerName.trim(),
    ownerPhone: data.ownerPhone.trim(),
    gstin,
    aadhaarRef,
    shopAddressPrivate: data.shopAddressPrivate.trim(),
    publicLabel: data.publicLabel.trim(),
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    categories: data.categories ?? [],
  };
}

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
    const data = toProfileData(req.body as z.infer<typeof kycSchema>);
    const profile = await prisma.supplierProfile.upsert({
      where: { userId: req.user!.id },
      create: {
        userId: req.user!.id,
        ...data,
        kycStatus: 'draft',
      },
      update: {
        ...data,
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

kycRouter.get('/admin/suppliers', authenticate, requireRole('admin'), async (req, res) => {
  const kycStatus = typeof req.query.kycStatus === 'string' ? req.query.kycStatus : undefined;
  const profiles = await prisma.supplierProfile.findMany({
    where: kycStatus ? { kycStatus: kycStatus as never } : undefined,
    include: { user: { select: { id: true, displayName: true, phone: true, email: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  res.json({ suppliers: profiles });
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

/**
 * Dev helper: self-verify when DEV_AUTH_BYPASS.
 * Upserts a minimal profile so verify works before the form is filled.
 */
kycRouter.post('/supplier/kyc/dev-verify', authenticate, requireRole('supplier'), async (req, res) => {
  if (process.env.DEV_AUTH_BYPASS !== 'true') {
    throw new AppError(403, 'FORBIDDEN', 'Only available in DEV_AUTH_BYPASS mode');
  }

  const userId = req.user!.id;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const existing = await prisma.supplierProfile.findUnique({ where: { userId } });
  const profile = existing
    ? await prisma.supplierProfile.update({
        where: { userId },
        data: { kycStatus: 'verified' },
      })
    : await prisma.supplierProfile.create({
        data: {
          userId,
          businessName: 'Dev Supplier',
          ownerName: user?.displayName?.trim() || 'Dev Owner',
          ownerPhone: user?.phone || '+910000000000',
          shopAddressPrivate: 'Dev address',
          publicLabel: 'Dev Supplier',
          kycStatus: 'verified',
          categories: [],
        },
      });

  res.json({ profile });
});
