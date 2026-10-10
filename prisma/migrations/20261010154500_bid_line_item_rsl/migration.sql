-- Per-item remaining shelf life on a supplier bid line.
ALTER TABLE "BidLineItem" ADD COLUMN IF NOT EXISTS "rslDaysAtDelivery" INTEGER;
