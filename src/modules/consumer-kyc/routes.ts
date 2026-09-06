import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/errors';
import { recordAdminAudit } from '../admin/audit';

export const consumerKycRouter = Router();

const kycSchema = z.object({
  restaurantName: z.string().min(1),
  ownerName: z.string().min(1),
  ownerPhone: z.string().min(8),
  aadhaarRef: z.string().optional().nullable(),
  /** Client may send the ID/business-doc upload as docRef — stored on aadhaarRef. */
  docRef: z.string().optional().nullable(),
  addressLine: z.string().min(1),
  city: z.string().optional().nullable(),
  publicLabel: z.string().optional().nullable(),
  lat: z.number().finite().optional().nullable(),
  lng: z.number().finite().optional().nullable(),
});

function toProfileData(data: z.infer<typeof kycSchema>) {
  const aadhaarRef = data.aadhaarRef || data.docRef || null;
  return {
    restaurantName: data.restaurantName.trim(),
    ownerName: data.ownerName.trim(),
    ownerPhone: data.ownerPhone.trim(),
    aadhaarRef,
    addressLine: data.addressLine.trim(),
    city: data.city?.trim() ? data.city.trim() : null,
    publicLabel: data.publicLabel?.trim() ? data.publicLabel.trim() : null,
    lat: data.lat ?? null,
    lng: data.lng ?? null,
  };
}

consumerKycRouter.get('/consumer/kyc', authenticate, requireRole('consumer'), async (req, res) => {
  const profile = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
  res.json({ profile });
});

consumerKycRouter.post(
  '/consumer/kyc',
  authenticate,
  requireRole('consumer'),
  validateBody(kycSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof kycSchema>;
    const data = toProfileData(body);

    const existing = await prisma.consumerProfile.findUnique({
      where: { userId: req.user!.id },
    });
    const profile = existing
      ? await prisma.consumerProfile.update({
          where: { userId: req.user!.id },
          data,
        })
      : await prisma.consumerProfile.create({
          data: {
            userId: req.user!.id,
            ...data,
            kycStatus: 'draft',
          },
        });
    res.json({ profile });
  },
);

consumerKycRouter.post(
  '/consumer/kyc/submit',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const existing = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
    if (!existing) throw new AppError(400, 'NO_KYC', 'Complete KYC form first');
    if (!existing.restaurantName?.trim() || !existing.ownerPhone?.trim() || !existing.addressLine?.trim()) {
      throw new AppError(
        400,
        'KYC_INCOMPLETE',
        'Restaurant/cafe name, phone, and address are required before submitting',
      );
    }
    const profile = await prisma.consumerProfile.update({
      where: { userId: req.user!.id },
      data: { kycStatus: 'submitted' },
    });
    res.json({ profile });
  },
);

consumerKycRouter.get('/admin/consumers', authenticate, requireRole('admin'), async (req, res) => {
  const kycStatus = typeof req.query.kycStatus === 'string' ? req.query.kycStatus : undefined;
  const profiles = await prisma.consumerProfile.findMany({
    where: kycStatus ? { kycStatus: kycStatus as never } : undefined,
    include: { user: { select: { id: true, displayName: true, phone: true, email: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  res.json({ consumers: profiles });
});

/** Admin / ops: verify consumer so they can send bid requests. */
consumerKycRouter.post(
  '/admin/consumer/:userId/verify',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    const userId = requireParam(req, 'userId');
    const profile = await prisma.consumerProfile.update({
      where: { userId },
      data: { kycStatus: 'verified' },
    });
    await recordAdminAudit({
      actorId: req.user!.id,
      action: 'kyc.verify',
      target: `consumer:${userId}`,
    });
    res.json({ profile });
  },
);

consumerKycRouter.post(
  '/admin/consumer/:userId/reject',
  authenticate,
  requireRole('admin'),
  async (req, res) => {
    const userId = requireParam(req, 'userId');
    const profile = await prisma.consumerProfile.update({
      where: { userId },
      data: { kycStatus: 'rejected' },
    });
    await recordAdminAudit({
      actorId: req.user!.id,
      action: 'kyc.reject',
      target: `consumer:${userId}`,
    });
    res.json({ profile });
  },
);

/**
 * Dev helper: self-verify when DEV_AUTH_BYPASS.
 * Upserts a minimal profile so verify works before the form is filled.
 */
consumerKycRouter.post(
  '/consumer/kyc/dev-verify',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    if (process.env.DEV_AUTH_BYPASS !== 'true') {
      throw new AppError(403, 'FORBIDDEN', 'Only available in DEV_AUTH_BYPASS mode');
    }

    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const existing = await prisma.consumerProfile.findUnique({ where: { userId } });
    const { sanitizeLabel } = await import('../../lib/user-present');
    const safeName = sanitizeLabel(user?.displayName);
    const profile = existing
      ? await prisma.consumerProfile.update({
          where: { userId },
          data: { kycStatus: 'verified' },
        })
      : await prisma.consumerProfile.create({
          data: {
            userId,
            restaurantName: safeName || 'Local restaurant',
            ownerName: safeName || 'Local restaurant',
            ownerPhone: user?.phone || '+910000000000',
            addressLine: 'Address pending',
            publicLabel: safeName || 'Local restaurant',
            kycStatus: 'verified',
          },
        });

    res.json({ profile });
  },
);
