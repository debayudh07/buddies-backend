import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireParam } from '../../middleware/params';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/errors';
import { presentUser, invalidateAvatarCache } from '../../lib/user-present';
import { uploadBuffer } from '../../lib/storage';
import { invalidateCachedAuthUser, setCachedAuthUser } from '../../lib/auth-cache';

export const identityRouter = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const name = (file.originalname || '').toLowerCase();
    const looksLikeImage =
      mime.startsWith('image/') ||
      mime === 'application/octet-stream' ||
      /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name);
    if (!looksLikeImage) {
      cb(new AppError(400, 'UNSUPPORTED_MEDIA', 'Avatar must be an image'));
      return;
    }
    cb(null, true);
  },
});

const sessionSchema = z.object({
  intendedRole: z.enum(['consumer', 'supplier']).optional(),
});

identityRouter.post('/auth/session', authenticate, async (req, res) => {
  const intended = sessionSchema.safeParse(req.body ?? {}).data?.intendedRole;

  // Apply the app surface role (consumer app → consumer, supplier app → supplier).
  // Same Supabase account can be used on both apps; route access uses this role.
  if (intended === 'consumer' || intended === 'supplier') {
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, role: true, supabaseId: true },
    });
    if (current && current.role !== intended) {
      await prisma.user.update({
        where: { id: current.id },
        data: { role: intended },
      });
      req.user!.role = intended;
      if (current.supabaseId) invalidateCachedAuthUser(current.supabaseId);
      invalidateCachedAuthUser(current.id);
      invalidateCachedAuthUser(`dev:${current.id}`);
    } else if (current) {
      req.user!.role = current.role;
    }

    const cacheKey = req.user!.supabaseId || req.user!.id;
    await setCachedAuthUser(cacheKey, {
      id: req.user!.id,
      role: req.user!.role,
      supabaseId: req.user!.supabaseId,
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      consumerProfile: true,
      supplierProfile: true,
      subscriptions: { where: { active: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json({ user: await presentUser(user) });
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
  res.json({ user: await presentUser(user) });
});

const meUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
});

identityRouter.patch(
  '/me',
  authenticate,
  validateBody(meUpdateSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof meUpdateSchema>;
    if (!body.displayName) {
      throw new AppError(400, 'NO_CHANGES', 'Nothing to update');
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { displayName: body.displayName },
      include: {
        consumerProfile: { include: { addresses: true } },
        supplierProfile: true,
        subscriptions: { where: { active: true } },
      },
    });
    res.json({ user: await presentUser(user) });
  },
);

/**
 * POST /v1/me/avatar — multipart field "file"
 * Uploads to Supabase Storage (buddies-profiles) and stores avatarStorageRef on User.
 */
identityRouter.post(
  '/me/avatar',
  authenticate,
  (req, res, next) => {
    avatarUpload.single('file')(req, res, (err) => {
      if (err instanceof AppError) return next(err);
      if (err) {
        return next(
          new AppError(
            400,
            'UPLOAD_ERROR',
            err instanceof Error ? err.message : 'Upload failed',
          ),
        );
      }
      return next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      throw new AppError(400, 'FILE_REQUIRED', 'multipart field "file" is required');
    }
    const originalName = req.file.originalname || 'avatar.jpg';
    let mimeType = req.file.mimetype || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      const lower = originalName.toLowerCase();
      if (lower.endsWith('.png')) mimeType = 'image/png';
      else if (lower.endsWith('.webp')) mimeType = 'image/webp';
      else if (lower.endsWith('.gif')) mimeType = 'image/gif';
      else mimeType = 'image/jpeg';
    }
    const stored = await uploadBuffer({
      purpose: 'profiles',
      userId: req.user!.id,
      buffer: req.file.buffer,
      mimeType,
      originalName,
      signedUrlTtlSec: 60 * 60 * 6,
    });

    const previous = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { avatarStorageRef: true },
    });

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatarStorageRef: stored.storageRef },
      include: {
        consumerProfile: { include: { addresses: true } },
        supplierProfile: true,
        subscriptions: { where: { active: true } },
      },
    });

    invalidateAvatarCache(previous?.avatarStorageRef);
    invalidateAvatarCache(stored.storageRef);

    res.status(201).json({
      user: await presentUser(user),
      storageRef: stored.storageRef,
      signedUrl: stored.signedUrl,
    });
  },
);

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

// Orders read the delivery point off ConsumerProfile, so the primary saved
// address has to be mirrored there or every order ends up without a pin.
async function mirrorAddressToProfile(
  consumerId: string,
  address: { line: string; city: string | null; lat: number | null; lng: number | null },
) {
  await prisma.consumerProfile.update({
    where: { id: consumerId },
    data: {
      addressLine: address.line,
      city: address.city ?? undefined,
      lat: address.lat ?? undefined,
      lng: address.lng ?? undefined,
    },
  });
}

identityRouter.post(
  '/consumer/addresses',
  authenticate,
  requireRole('consumer'),
  validateBody(addressSchema),
  async (req, res) => {
    const consumer = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
    if (!consumer) throw new AppError(400, 'NO_PROFILE', 'Create consumer profile first');

    const existingCount = await prisma.address.count({ where: { consumerId: consumer.id } });
    const body = req.body as z.infer<typeof addressSchema>;
    const makeDefault = body.isDefault === true || existingCount === 0;

    const address = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({
          where: { consumerId: consumer.id },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: { consumerId: consumer.id, ...body, isDefault: makeDefault },
      });
    });

    if (makeDefault) await mirrorAddressToProfile(consumer.id, address);

    res.status(201).json({ address });
  },
);

identityRouter.post(
  '/consumer/addresses/:id/default',
  authenticate,
  requireRole('consumer'),
  async (req, res) => {
    const consumer = await prisma.consumerProfile.findUnique({ where: { userId: req.user!.id } });
    if (!consumer) throw new AppError(400, 'NO_PROFILE', 'Create consumer profile first');

    const addressId = requireParam(req, 'id');
    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.consumerId !== consumer.id) {
      throw new AppError(404, 'NOT_FOUND', 'Address not found');
    }

    await prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { consumerId: consumer.id },
        data: { isDefault: false },
      });
      await tx.address.update({ where: { id: address.id }, data: { isDefault: true } });
    });

    await mirrorAddressToProfile(consumer.id, address);

    res.json({ address: { ...address, isDefault: true } });
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

const preferencesSchema = z.object({
  pushEnabled: z.boolean().optional(),
  bidAlerts: z.boolean().optional(),
  orderAlerts: z.boolean().optional(),
});

identityRouter.get('/me/preferences', authenticate, async (req, res) => {
  const preference = await prisma.userPreference.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id },
    update: {},
  });
  res.json({ preference });
});

identityRouter.put(
  '/me/preferences',
  authenticate,
  validateBody(preferencesSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof preferencesSchema>;
    const preference = await prisma.userPreference.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...body },
      update: body,
    });
    res.json({ preference });
  },
);
