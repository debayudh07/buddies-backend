-- Persist the consumer's chosen expected-delivery window.
ALTER TABLE "BidRequest" ADD COLUMN "slaHours" INTEGER;

-- Backfill slaHours from the stored delivery deadline where we have one.
UPDATE "BidRequest"
SET "slaHours" = GREATEST(1, ROUND(EXTRACT(EPOCH FROM ("preferredDeliverBy" - "createdAt")) / 3600))
WHERE "preferredDeliverBy" IS NOT NULL;

-- Remap legacy bidding TTLs onto the new allowed set {0, 6, 12, 24}.
-- New meaning: 0 -> 12h SLA, 6 -> 24h, 12 -> 36h, 24 -> 48h.
UPDATE "BidRequest"
SET "durationHours" = CASE "durationHours"
  WHEN 24 THEN 12
  WHEN 48 THEN 24
  WHEN 72 THEN 24
  WHEN 168 THEN 24
  ELSE "durationHours"
END
WHERE "durationHours" NOT IN (0, 6, 12);

-- New default for fresh rows.
ALTER TABLE "BidRequest" ALTER COLUMN "durationHours" SET DEFAULT 0;
