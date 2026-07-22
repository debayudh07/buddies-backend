import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/errors';

export const identityRouter = Router();

identityRouter.post('/auth/session', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      consumerProfile: true,
      supplierProfile: true,
      subscriptions: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json({ user });
});

identityRouter.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      consumerProfile: { include: { addresses: true } },
      supplierProfile: true,
      subscriptions: { where: { active: true } },
    },
  });
  res.json({ user });
});

const consumerProfileSchema = z.object({
  restaurantName: z.string().min(1).optional(),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  displayName: z.string().optional(),
});

identityRouter.put(
  '/consumer/profile',
  authenticate,
  requireRole('consumer'),
  validateBody(consumerProfileSchema),
  async (req, res) => {
    const { displayName, ...profile } = req.body as z.infer<typeof consumerProfileSchema>;
    if (displayName) {
      await prisma.user.update({ where: { id: req.user!.id }, data: { displayName } });
    }
    const consumer = await prisma.consumerProfile.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...profile },
      update: profile,
    });
    res.json({ consumer });
  },
);

identityRouter.post(
  '/me/privacy-accept',
  authenticate,
  async (req, res) => {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { privacyAcceptedAt: new Date() },
    });
    res.json({ privacyAcceptedAt: user.privacyAcceptedAt });
  },
);

const addressSchema = z.object({
  label: z.string(),
  line: z.string(),
  city: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  isDefault: z.boolean().optional(),
});

identityRouter.post(
  '/consumer/addresses',
  authenticate,
  requireRole('consumer'),
  validateBody(addressSchema),
  async (req, res) => {
    const consumer = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
    if (!consumer) throw new AppError(400, 'NO_PROFILE', 'Create consumer profile first');
    const address = await prisma.address.create({
      data: { consumerId: consumer.id, ...req.body },
    });
    res.status(201).json({ address });
  },
);

identityRouter.post(
  '/devices',
  authenticate,
  validateBody(z.object({ token: z.string(), platform: z.string().optional() })),
  async (req, res) => {
    const device = await prisma.deviceToken.upsert({
      where: { userId_token: { userId: req.user!.id, token: req.body.token } },
      create: { userId: req.user!.id, token: req.body.token, platform: req.body.platform },
      update: { platform: req.body.platform },
    });
    res.status(201).json({ device });
  },
);
