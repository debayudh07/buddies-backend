import { randomUUID } from 'crypto';
import path from 'path';
import { getSupabaseAdmin } from './supabase';
import { AppError } from './errors';
import { logger } from './logger';
import { prisma } from './prisma';
import type { AuthUser } from '../middleware/auth';

export const STORAGE_BUCKETS = {
  kyc: 'buddies-kyc',
  returns: 'buddies-returns',
  chat: 'buddies-chat',
  payments: 'buddies-payments',
  challans: 'buddies-challans',
  profiles: 'buddies-profiles',
} as const;

export type StoragePurpose = keyof typeof STORAGE_BUCKETS;

const PURPOSE_SET = new Set<string>(Object.keys(STORAGE_BUCKETS));
const BUCKET_SET = new Set<string>(Object.values(STORAGE_BUCKETS));

/** Max signed-url TTL clients may request (6h). */
export const MAX_SIGNED_URL_TTL_SEC = 60 * 60 * 6;
export const DEFAULT_SIGNED_URL_TTL_SEC = 3600;

export function isStoragePurpose(value: string): value is StoragePurpose {
  return PURPOSE_SET.has(value);
}

export function isKnownBucket(bucket: string): boolean {
  return BUCKET_SET.has(bucket);
}

export type StoredObject = {
  bucket: string;
  path: string;
  storageRef: string; // "bucket/path" — persist this in DB ref fields
  mediaType: string;
  size: number;
  signedUrl: string | null;
};

export type ParsedStorageRef = {
  bucket: string;
  objectPath: string;
  storageRef: string;
};

let bucketsReady = false;

/** Create private buckets if missing (service role). Prefer IaC in production. */
export async function ensureStorageBuckets(): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    logger.warn('storage', 'Supabase admin client missing — uploads disabled');
    return;
  }

  const { data: existing, error: listErr } = await supabase.storage.listBuckets();
  if (listErr) {
    logger.warn('storage', 'listBuckets failed', { error: listErr.message });
    return;
  }
  const names = new Set((existing ?? []).map((b) => b.name));

  for (const bucket of Object.values(STORAGE_BUCKETS)) {
    if (names.has(bucket)) continue;
    const { error } = await supabase.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: 50 * 1024 * 1024,
      allowedMimeTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'video/mp4',
        'video/quicktime',
        'application/pdf',
      ],
    });
    if (error && !/already exists/i.test(error.message)) {
      logger.warn('storage', `createBucket ${bucket} failed`, { error: error.message });
    } else {
      logger.info('storage', `bucket ready: ${bucket}`);
    }
  }
  bucketsReady = true;
  logger.info('storage', 'Supabase Storage buckets ensured');
}

function extFrom(filename: string, mime: string): string {
  const fromName = path.extname(filename).replace('.', '').toLowerCase();
  if (fromName) return fromName.slice(0, 8);
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
  };
  return map[mime] ?? 'bin';
}

export function parseStorageRef(storageRef: string): ParsedStorageRef {
  const slash = storageRef.indexOf('/');
  if (slash <= 0) {
    throw new AppError(400, 'INVALID_STORAGE_REF', 'storageRef must be bucket/path');
  }
  const bucket = storageRef.slice(0, slash);
  const objectPath = storageRef.slice(slash + 1);
  if (!objectPath) {
    throw new AppError(400, 'INVALID_STORAGE_REF', 'storageRef must be bucket/path');
  }
  if (!isKnownBucket(bucket)) {
    throw new AppError(400, 'UNKNOWN_BUCKET', `Unknown storage bucket: ${bucket}`);
  }
  return { bucket, objectPath, storageRef };
}

/**
 * Authenticated users may only sign objects they own by path prefix
 * (`{userId}/…`) or that appear on domain rows they can access.
 */
export async function assertCanAccessStorageRef(
  user: AuthUser,
  storageRef: string,
): Promise<ParsedStorageRef> {
  const parsed = parseStorageRef(storageRef);
  const { objectPath } = parsed;

  // Upload convention: {userId}/{purpose}/{uuid}.ext
  if (objectPath.startsWith(`${user.id}/`)) {
    return parsed;
  }

  if (user.role === 'admin') {
    return parsed;
  }

  // Avatar on own user
  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { avatarStorageRef: true },
  });
  if (me?.avatarStorageRef === storageRef) {
    return parsed;
  }

  // Return evidence on a claim the user participates in
  const evidence = await prisma.returnEvidence.findFirst({
    where: {
      storageRef,
      claim: {
        OR: [{ consumerUserId: user.id }, { supplierUserId: user.id }],
      },
    },
    select: { id: true },
  });
  if (evidence) return parsed;

  // Payment screenshot on an order the user is party to
  const payment = await prisma.offlinePayment.findFirst({
    where: {
      screenshotRef: storageRef,
      order: {
        OR: [{ consumerUserId: user.id }, { supplierUserId: user.id }],
      },
    },
    select: { id: true },
  });
  if (payment) return parsed;

  // Challan signature on an order the user is party to
  const challan = await prisma.digitalChallan.findFirst({
    where: {
      signatureRef: storageRef,
      order: {
        OR: [{ consumerUserId: user.id }, { supplierUserId: user.id }],
      },
    },
    select: { id: true },
  });
  if (challan) return parsed;

  // Chat image on a thread the user belongs to
  const chatMsg = await prisma.chatMessage.findFirst({
    where: {
      imageRef: storageRef,
      thread: {
        OR: [{ consumerUserId: user.id }, { supplierUserId: user.id }],
      },
    },
    select: { id: true },
  });
  if (chatMsg) return parsed;

  // KYC docs on supplier profile (path usually user-owned; also match stored refs)
  const supplier = await prisma.supplierProfile.findFirst({
    where: { userId: user.id },
    select: { aadhaarRef: true },
  });
  if (supplier?.aadhaarRef === storageRef) return parsed;

  throw new AppError(403, 'STORAGE_FORBIDDEN', 'Not allowed to access this object');
}

export async function uploadBuffer(opts: {
  purpose: StoragePurpose;
  userId: string;
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  signedUrlTtlSec?: number;
}): Promise<StoredObject> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Supabase Storage is not configured');
  }
  if (!bucketsReady) {
    await ensureStorageBuckets();
  }

  const bucket = STORAGE_BUCKETS[opts.purpose];
  const ext = extFrom(opts.originalName, opts.mimeType);
  const objectPath = `${opts.userId}/${opts.purpose}/${randomUUID()}.${ext}`;

  let { error } = await supabase.storage.from(bucket).upload(objectPath, opts.buffer, {
    contentType: opts.mimeType,
    upsert: false,
  });

  // Bucket may not exist yet (e.g. profiles added after first boot).
  if (error && /bucket not found|not found/i.test(error.message)) {
    logger.warn('storage', `bucket missing, creating ${bucket}`);
    bucketsReady = false;
    await ensureStorageBuckets();
    ({ error } = await supabase.storage.from(bucket).upload(objectPath, opts.buffer, {
      contentType: opts.mimeType,
      upsert: false,
    }));
  }

  if (error) {
    logger.error('storage', 'upload failed', { bucket, path: objectPath, error: error.message });
    throw new AppError(502, 'STORAGE_UPLOAD_FAILED', error.message);
  }

  const storageRef = `${bucket}/${objectPath}`;
  const ttl = Math.min(
    opts.signedUrlTtlSec ?? DEFAULT_SIGNED_URL_TTL_SEC,
    MAX_SIGNED_URL_TTL_SEC,
  );
  const { data: signed, error: signErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, ttl);
  if (signErr) {
    logger.warn('storage', 'signed URL failed', { error: signErr.message });
  }

  logger.info('storage', 'uploaded', {
    purpose: opts.purpose,
    storageRef,
    bytes: opts.buffer.length,
    mediaType: opts.mimeType,
  });

  return {
    bucket,
    path: objectPath,
    storageRef,
    mediaType: opts.mimeType,
    size: opts.buffer.length,
    signedUrl: signed?.signedUrl ?? null,
  };
}

export async function createSignedUrlForRef(
  storageRef: string,
  ttlSec = DEFAULT_SIGNED_URL_TTL_SEC,
): Promise<string> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Supabase Storage is not configured');
  }
  const { bucket, objectPath } = parseStorageRef(storageRef);
  const ttl = Math.min(Math.max(1, ttlSec), MAX_SIGNED_URL_TTL_SEC);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, ttl);
  if (error || !data?.signedUrl) {
    throw new AppError(404, 'STORAGE_OBJECT_MISSING', error?.message ?? 'Object not found');
  }
  return data.signedUrl;
}
