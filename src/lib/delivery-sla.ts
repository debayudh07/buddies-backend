import { AppError } from './errors';

/** Bidding time-to-live (hours) the consumer may pick. 0 = Instant (30 min). */
export const ALLOWED_DURATION_HOURS = [0, 6, 12, 24] as const;
export type AllowedDurationHours = (typeof ALLOWED_DURATION_HOURS)[number];

/**
 * Minimum expected-delivery window (hours from creation) for each bidding TTL:
 *   30 min → 6h · 6h → 24h · 12h → 36h · 24h → 48h
 * Legacy keys kept so old rows still resolve a sane deadline.
 */
const SLA_BY_DURATION: Record<number, number> = {
  0: 6,
  6: 24,
  12: 36,
  24: 48,
  48: 72,
  72: 168,
  168: 242,
};

export function isAllowedDurationHours(
  hours: number | null | undefined,
): hours is AllowedDurationHours {
  return (
    typeof hours === 'number' &&
    (ALLOWED_DURATION_HOURS as readonly number[]).includes(hours)
  );
}

/** Minimum / fallback delivery window in hours for a bidding TTL. */
export function deliverySlaHours(
  durationHours: number | null | undefined,
): number {
  const h = durationHours ?? 0;
  return SLA_BY_DURATION[h] ?? 48;
}

/** The mapped minimum expected-delivery hours the consumer may pick for a TTL. */
export function minSlaHoursFor(durationHours: number | null | undefined): number {
  return deliverySlaHours(durationHours);
}

export function deliverySlaDeadline(
  from: Date,
  durationHours: number | null | undefined,
): Date {
  return new Date(from.getTime() + deliverySlaHours(durationHours) * 3600 * 1000);
}

export function withDeliverySla<
  T extends { durationHours?: number | null; slaHours?: number | null },
>(row: T): T & { deliverySlaHours: number } {
  return {
    ...row,
    deliverySlaHours: row.slaHours ?? deliverySlaHours(row.durationHours),
  };
}

/** "Expected delivery" hour choices a consumer may pick. */
export const ALLOWED_SLA_HOURS = [6, 12, 24, 36, 48] as const;
export type AllowedSlaHours = (typeof ALLOWED_SLA_HOURS)[number];

/**
 * Expected-delivery options for a bidding TTL: the mapped minimum and anything
 * longer (a consumer can always allow more time, never less than the mapping).
 */
export function allowedSlaHoursFor(durationHours: number | null | undefined): number[] {
  const min = minSlaHoursFor(durationHours);
  return ALLOWED_SLA_HOURS.filter((h) => h >= min);
}

export function isAllowedSlaHours(
  hours: number | null | undefined,
  durationHours: number | null | undefined,
): hours is number {
  return typeof hours === 'number' && allowedSlaHoursFor(durationHours).includes(hours);
}

/** Validate a date against an explicit absolute cap (e.g. bidRequest.preferredDeliverBy), rather
 * than recomputing one from durationHours. Use this once a concrete cap is already known. */
export function assertWithinCap(opts: {
  at: Date;
  cap: Date;
  label: string;
  after?: Date;
}): void {
  if (opts.at.getTime() > opts.cap.getTime() + 1000) {
    throw new AppError(
      400,
      'DELIVERY_OUTSIDE_SLA',
      `${opts.label} must be by ${opts.cap.toISOString()}`,
    );
  }
  if (opts.after && opts.at.getTime() < opts.after.getTime() - 1000) {
    throw new AppError(400, 'DELIVERY_IN_PAST', `${opts.label} must be in the future`);
  }
}

export function parseIsoDate(raw: unknown): Date | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Preferred / promised time must fall at or before createdAt + matrix hours. */
export function assertWithinDeliverySla(opts: {
  at: Date;
  createdAt: Date;
  durationHours: number | null | undefined;
  label: string;
  after?: Date;
}): void {
  const cap = deliverySlaDeadline(opts.createdAt, opts.durationHours);
  if (opts.at.getTime() > cap.getTime() + 1000) {
    const hours = deliverySlaHours(opts.durationHours);
    throw new AppError(
      400,
      'DELIVERY_OUTSIDE_SLA',
      `${opts.label} must be within ${hours} hours of the request`,
    );
  }
  if (opts.after && opts.at.getTime() < opts.after.getTime() - 1000) {
    throw new AppError(
      400,
      'DELIVERY_IN_PAST',
      `${opts.label} must be in the future`,
    );
  }
}
