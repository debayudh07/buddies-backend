import { AppError } from './errors';

/** Auction durationHours values the consumer may pick. */
export const ALLOWED_DURATION_HOURS = [0, 24, 48] as const;
export type AllowedDurationHours = (typeof ALLOWED_DURATION_HOURS)[number];

/** Delivery cap (hours) keyed by auction durationHours. Instant (0) → 12h. */
const SLA_BY_DURATION: Record<number, number> = {
  0: 12,
  24: 36,
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

/** Hours the order may stay open after award. Instant → 12. */
export function deliverySlaHours(
  durationHours: number | null | undefined,
): number {
  const h = durationHours ?? 24;
  return SLA_BY_DURATION[h] ?? 36;
}

export function deliverySlaDeadline(
  from: Date,
  durationHours: number | null | undefined,
): Date {
  return new Date(from.getTime() + deliverySlaHours(durationHours) * 3600 * 1000);
}

export function withDeliverySla<T extends { durationHours?: number | null }>(
  row: T,
): T & { deliverySlaHours: number } {
  return { ...row, deliverySlaHours: deliverySlaHours(row.durationHours) };
}

/** "Expected delivery" hour choices a consumer may pick, keyed by bid live time (durationHours). */
export const ALLOWED_SLA_HOURS = [12, 24, 48] as const;
export type AllowedSlaHours = (typeof ALLOWED_SLA_HOURS)[number];

/** SLA-hour options available for a given bid live time — must be able to deliver after bidding closes. */
export function allowedSlaHoursFor(durationHours: number | null | undefined): number[] {
  const d = durationHours ?? 0;
  return ALLOWED_SLA_HOURS.filter((h) => h >= d);
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
