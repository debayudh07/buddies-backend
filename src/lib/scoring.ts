export type ScoreInput = {
  amountPaise: number;
  budgetPaise?: number | null;
  rslDays: number;
  minRslDays?: number;
  distanceKm: number;
  onTimeRate: number;
  rating: number;
  weights?: {
    price: number;
    rsl: number;
    distance: number;
    onTime: number;
    rating: number;
  };
};

/** Higher score is better. Price lower → better. */
export function computeBidScore(input: ScoreInput) {
  const w = input.weights ?? {
    price: 0.45,
    rsl: 0.2,
    distance: 0.15,
    onTime: 0.15,
    rating: 0.05,
  };

  const budget = input.budgetPaise && input.budgetPaise > 0 ? input.budgetPaise : input.amountPaise * 1.2;
  const priceScore = Math.max(0, Math.min(1, 1 - input.amountPaise / (budget * 1.5)));
  const minRsl = input.minRslDays ?? 2;
  const rslScore = Math.max(0, Math.min(1, input.rslDays / Math.max(minRsl * 2, 1)));
  const distanceScore = Math.max(0, Math.min(1, 1 - input.distanceKm / 30));
  const onTimeScore = Math.max(0, Math.min(1, input.onTimeRate / 100));
  const ratingScore = Math.max(0, Math.min(1, input.rating / 5));

  const score =
    w.price * priceScore +
    w.rsl * rslScore +
    w.distance * distanceScore +
    w.onTime * onTimeScore +
    w.rating * ratingScore;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      price: priceScore,
      rsl: rslScore,
      distance: distanceScore,
      onTime: onTimeScore,
      rating: ratingScore,
    },
  };
}
