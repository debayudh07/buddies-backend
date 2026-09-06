import type { ConsumerProfile, SupplierProfile, User } from '@prisma/client';
import { createSignedUrlForRef } from './storage';
import { prisma } from './prisma';
import { consumerPublicRating, supplierPublicRating } from './ratings';

type UserWithProfiles = User & {
  supplierProfile?: SupplierProfile | null;
  consumerProfile?: ConsumerProfile | null;
};

/** Drop empty or `Dev …` / `dev:` labels so they never reach clients. */
export function sanitizeLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = value.trim();
  if (!s) return null;
  if (/^dev[ :]/i.test(s)) return null;
  return s;
}

export function publicSupplierLabel(
  profile:
    | { publicLabel?: string | null; businessName?: string | null }
    | null
    | undefined,
  fallback = 'Local supplier',
): string {
  return (
    sanitizeLabel(profile?.publicLabel) ??
    sanitizeLabel(profile?.businessName) ??
    fallback
  );
}

const avatarCache = new Map<string, { url: string | null; exp: number }>();
const AVATAR_TTL_MS = 30 * 60 * 1000; // 30 min (signed URLs last 6h)

/** Attach a short-lived signed avatar URL + flattened KYC status for clients. */
export async function presentUser<T extends UserWithProfiles | null>(user: T) {
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

  let rating: number | null = null;
  let ratingCount = 0;
  let onTimeRate: number | null = null;
  let trustScore: number | null = null;
  if (user.supplierProfile) {
    const snap = supplierPublicRating(user.supplierProfile);
    rating = snap.displayed;
    ratingCount = snap.ratingCount;
    onTimeRate = user.supplierProfile.onTimeRate;
  } else if (user.consumerProfile) {
    const snap = consumerPublicRating(user.consumerProfile);
    rating = snap.displayed;
    ratingCount = snap.ratingCount;
    trustScore = user.consumerProfile.trustScore;
  }

  const recentReviews = await prisma.orderRating.findMany({
    where: { toUserId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { stars: true, comment: true, createdAt: true, fromRole: true },
  });

  const supplier = user.supplierProfile
    ? {
        ...user.supplierProfile,
        publicLabel: publicSupplierLabel(user.supplierProfile),
        businessName:
          sanitizeLabel(user.supplierProfile.businessName) ??
          user.supplierProfile.businessName,
        ownerName:
          sanitizeLabel(user.supplierProfile.ownerName) ??
          user.supplierProfile.ownerName,
      }
    : user.supplierProfile;
  const consumer = user.consumerProfile
    ? {
        ...user.consumerProfile,
        restaurantName:
          sanitizeLabel(user.consumerProfile.restaurantName) ??
          user.consumerProfile.restaurantName,
      }
    : user.consumerProfile;

  return {
    ...user,
    displayName: sanitizeLabel(user.displayName),
    supplierProfile: supplier,
    consumerProfile: consumer,
    avatarUrl,
    kycStatus: supplier?.kycStatus ?? consumer?.kycStatus ?? null,
    rating,
    ratingCount,
    onTimeRate,
    trustScore,
    recentReviews,
  };
}

export function invalidateAvatarCache(storageRef: string | null | undefined) {
  if (storageRef) avatarCache.delete(storageRef);
}
