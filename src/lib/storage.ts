import { randomUUID } from 'crypto';
import path from 'path';
import { getSupabaseAdmin } from './supabase';
import { AppError } from './errors';
import { logger } from './logger';

export const STORAGE_BUCKETS = {
  kyc: 'buddies-kyc',
  returns: 'buddies-returns',
  chat: 'buddies-chat',
  payments: 'buddies-payments',
  challans: 'buddies-challans',
} as const;

export type StoragePurpose = keyof typeof STORAGE_BUCKETS;

const PURPOSE_SET = new Set<string>(Object.keys(STORAGE_BUCKETS));

export function isStoragePurpose(value: string): value is StoragePurpose {
  return PURPOSE_SET.has(value);
}

export type StoredObject = {
  bucket: string;
  path: string;
  storageRef: string; // "bucket/path" — persist this in DB ref fields
  mediaType: string;
  size: number;
  signedUrl: string | null;
  publicUrl: string | null;
};

let bucketsReady = false;

/** Create private buckets if missing (service role). */
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

  const { error } = await supabase.storage.from(bucket).upload(objectPath, opts.buffer, {
    contentType: opts.mimeType,
    upsert: false,
  });
  if (error) {
    logger.error('storage', 'upload failed', { bucket, path: objectPath, error: error.message });
    throw new AppError(502, 'STORAGE_UPLOAD_FAILED', error.message);
  }

  const storageRef = `${bucket}/${objectPath}`;
  const ttl = opts.signedUrlTtlSec ?? 60 * 60;
  const { data: signed, error: signErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, ttl);
  if (signErr) {
    logger.warn('storage', 'signed URL failed', { error: signErr.message });
  }

  const { data: pub } = supabase.storage.from(bucket).getPublicUrl(objectPath);

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
    // buckets are private — publicUrl only works if bucket is made public later
    publicUrl: pub?.publicUrl ?? null,
  };
}

export async function createSignedUrlForRef(
  storageRef: string,
  ttlSec = 3600,
): Promise<string> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Supabase Storage is not configured');
  }
  const slash = storageRef.indexOf('/');
  if (slash <= 0) {
    throw new AppError(400, 'INVALID_STORAGE_REF', 'storageRef must be bucket/path');
  }
  const bucket = storageRef.slice(0, slash);
  const objectPath = storageRef.slice(slash + 1);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, ttlSec);
  if (error || !data?.signedUrl) {
    throw new AppError(404, 'STORAGE_OBJECT_MISSING', error?.message ?? 'Object not found');
  }
  return data.signedUrl;
}
