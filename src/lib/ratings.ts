/**
 * Mutual order ratings — blend peer stars (1–5) with in-app performance.
 * Public displayed score is always in [1, 5].
 */

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Supplier in-app performance → 1–5 stars. */
export function perfStarsSupplier(input: {
  onTimeRate: number;
  returnRate: number;
  challanAdjustRate: number;
}): number {
  const onTime = clamp(input.onTimeRate / 100, 0, 1);
  const returns = clamp(1 - input.returnRate / 100, 0, 1);
  const adjust = clamp(1 - Math.min(input.challanAdjustRate, 100) / 100, 0, 1);
  const perf01 = clamp(0.55 * onTime + 0.3 * returns + 0.15 * adjust, 0, 1);
  return round1(1 + 4 * perf01);
}

/** Consumer trustScore (0–100) → 1–5 stars. */
export function perfStarsConsumer(trustScore: number): number {
  return round1(1 + 4 * clamp(trustScore / 100, 0, 1));
}

/**
 * Blended public rating.
 * No peer ratings yet → performance only.
 * Else 65% peer average + 35% performance.
 */
export function blendRating(
  avgPeerStars: number | null,
  ratingCount: number,
  perfStars: number,
): number {
  if (!ratingCount || avgPeerStars == null) {
    return round1(perfStars);
  }
  return round1(0.65 * avgPeerStars + 0.35 * perfStars);
}

/** EWMA toward new stars (α = 0.2). */
export function ewmaRating(current: number, stars: number, alpha = 0.2): number {
  return round1(current * (1 - alpha) + stars * alpha);
}

/** Map stars → trustScore contribution and EWMA (α = 0.2). */
export function ewmaTrustFromStars(currentTrust: number, stars: number, alpha = 0.2): number {
  const target = (stars / 5) * 100;
  return round1(clamp(currentTrust * (1 - alpha) + target * alpha, 0, 100));
}

export type PublicRatingSnapshot = {
  displayed: number;
  perfStars: number;
  avgPeerStars: number | null;
  ratingCount: number;
};

export function supplierPublicRating(profile: {
  rating: number;
  ratingCount: number;
  onTimeRate: number;
  returnRate: number;
  challanAdjustRate: number;
}): PublicRatingSnapshot {
  const perf = perfStarsSupplier(profile);
  // `rating` field is maintained as EWMA of peer stars (or default 5).
  // For blend we need average peer stars — approximate with stored rating when count > 0.
  const avgPeer = profile.ratingCount > 0 ? profile.rating : null;
  return {
    displayed: blendRating(avgPeer, profile.ratingCount, perf),
    perfStars: perf,
    avgPeerStars: avgPeer,
    ratingCount: profile.ratingCount,
  };
}

export function consumerPublicRating(profile: {
  rating: number;
  ratingCount: number;
  trustScore: number;
}): PublicRatingSnapshot {
  const perf = perfStarsConsumer(profile.trustScore);
  const avgPeer = profile.ratingCount > 0 ? profile.rating : null;
  return {
    displayed: blendRating(avgPeer, profile.ratingCount, perf),
    perfStars: perf,
    avgPeerStars: avgPeer,
    ratingCount: profile.ratingCount,
  };
}
