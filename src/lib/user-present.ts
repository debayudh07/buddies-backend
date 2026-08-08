import type { SupplierProfile, User } from '@prisma/client';
import { createSignedUrlForRef } from './storage';

type UserWithSupplier = User & { supplierProfile?: SupplierProfile | null };

const avatarCache = new Map<string, { url: string | null; exp: number }>();
const AVATAR_TTL_MS = 30 * 60 * 1000; // 30 min (signed URLs last 6h)

/** Attach a short-lived signed avatar URL + flattened KYC status for clients. */
export async function presentUser<T extends UserWithSupplier | null>(user: T) {
  if (!user) return null;
  let avatarUrl: string | null = null;
  if (user.avatarStorageRef) {
    const key = user.avatarStorageRef;
    const hit = avatarCache.get(key);
    if (hit && Date.now() < hit.exp) {
      avatarUrl = hit.url;
    } else {
      try {
        avatarUrl = await createSignedUrlForRef(user.avatarStorageRef, 60 * 60 * 6);
      } catch {
        avatarUrl = null;
      }
      avatarCache.set(key, { url: avatarUrl, exp: Date.now() + AVATAR_TTL_MS });
      if (avatarCache.size > 2000) {
        const first = avatarCache.keys().next().value;
        if (first) avatarCache.delete(first);
      }
    }
  }
  return {
    ...user,
    avatarUrl,
    kycStatus: user.supplierProfile?.kycStatus ?? null,
  };
}

export function invalidateAvatarCache(storageRef: string | null | undefined) {
  if (storageRef) avatarCache.delete(storageRef);
}
