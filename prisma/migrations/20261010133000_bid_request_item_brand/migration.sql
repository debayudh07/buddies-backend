-- Optional preferred brand on each bid-request line.
ALTER TABLE "BidRequestItem" ADD COLUMN IF NOT EXISTS "brand" TEXT;
