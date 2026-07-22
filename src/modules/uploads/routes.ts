import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth';
import { AppError } from '../../lib/errors';
import {
  createSignedUrlForRef,
  isStoragePurpose,
  uploadBuffer,
  type StoragePurpose,
} from '../../lib/storage';

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype.startsWith('image/') ||
      file.mimetype.startsWith('video/') ||
      file.mimetype === 'application/pdf';
    if (!ok) {
      cb(new AppError(400, 'UNSUPPORTED_MEDIA', `Unsupported type: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

/**
 * POST /v1/uploads?purpose=returns|kyc|chat|payments|challans
 * multipart field name: file
 * Returns storageRef to persist on evidence / chat / payment / challan fields.
 */
uploadsRouter.post('/uploads', authenticate, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
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
}, async (req, res) => {
  const purposeRaw = String(req.query.purpose ?? req.body?.purpose ?? '');
  if (!isStoragePurpose(purposeRaw)) {
    throw new AppError(
      400,
      'INVALID_PURPOSE',
      'purpose must be one of: kyc, returns, chat, payments, challans',
    );
  }
  const purpose = purposeRaw as StoragePurpose;
  if (!req.file) {
    throw new AppError(400, 'FILE_REQUIRED', 'multipart field "file" is required');
  }

  const stored = await uploadBuffer({
    purpose,
    userId: req.user!.id,
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
    originalName: req.file.originalname || 'upload.bin',
  });

  res.status(201).json({
    storageRef: stored.storageRef,
    mediaType: stored.mediaType,
    size: stored.size,
    bucket: stored.bucket,
    path: stored.path,
    signedUrl: stored.signedUrl,
    // alias for existing API field names
    imageRef: stored.storageRef,
    screenshotRef: stored.storageRef,
    signatureRef: stored.storageRef,
  });
});

/** GET /v1/uploads/signed-url?storageRef=bucket/path */
uploadsRouter.get('/uploads/signed-url', authenticate, async (req, res) => {
  const storageRef = String(req.query.storageRef ?? '');
  if (!storageRef) {
    throw new AppError(400, 'STORAGE_REF_REQUIRED', 'storageRef query param required');
  }
  const ttl = Number(req.query.ttlSec ?? 3600);
  const signedUrl = await createSignedUrlForRef(storageRef, ttl);
  res.json({ storageRef, signedUrl, expiresInSec: ttl });
});
