-- CreateEnum
CREATE TYPE "ReturnResolution" AS ENUM ('refund', 'replacement');

-- CreateEnum
CREATE TYPE "ThreadKind" AS ENUM ('order', 'return_claim');

-- AlterEnum
ALTER TYPE "ReturnClaimStatus" ADD VALUE IF NOT EXISTS 'pickup_scheduled';
ALTER TYPE "ReturnClaimStatus" ADD VALUE IF NOT EXISTS 'picked_up';
ALTER TYPE "ReturnClaimStatus" ADD VALUE IF NOT EXISTS 'refunded';
ALTER TYPE "ReturnClaimStatus" ADD VALUE IF NOT EXISTS 'replaced';

-- AlterTable ReturnClaim
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "resolutionType" "ReturnResolution";
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "refundAmountPaise" INTEGER;
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "refundReceiptRef" TEXT;
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "refundReceivedAt" TIMESTAMP(3);
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "pickupScheduledAt" TIMESTAMP(3);
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "pickupWindow" TEXT;
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "pickedUpAt" TIMESTAMP(3);
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "replacedAt" TIMESTAMP(3);
ALTER TABLE "ReturnClaim" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);

-- AlterTable ChatThread
ALTER TABLE "ChatThread" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "returnClaimId" TEXT;
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "threadKind" "ThreadKind" NOT NULL DEFAULT 'order';

-- Drop old unique on orderId if present
ALTER TABLE "ChatThread" DROP CONSTRAINT IF EXISTS "ChatThread_orderId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ChatThread_returnClaimId_key" ON "ChatThread"("returnClaimId");
CREATE UNIQUE INDEX IF NOT EXISTS "ChatThread_orderId_threadKind_key" ON "ChatThread"("orderId", "threadKind");

ALTER TABLE "ChatThread" DROP CONSTRAINT IF EXISTS "ChatThread_returnClaimId_fkey";
ALTER TABLE "ChatThread"
  ADD CONSTRAINT "ChatThread_returnClaimId_fkey"
  FOREIGN KEY ("returnClaimId") REFERENCES "ReturnClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
