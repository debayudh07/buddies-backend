-- The consumer KYC form has always collected the FSSAI licence and business PAN,
-- but there was nowhere to store them: the Zod schema dropped both keys silently,
-- so every submitted value was discarded. Add the columns so they persist.
ALTER TABLE "ConsumerProfile" ADD COLUMN "fssai" TEXT;
ALTER TABLE "ConsumerProfile" ADD COLUMN "pan" TEXT;

-- Same problem for the Edit Profile screen's delivery-notes box: it was POSTed
-- to PATCH /me, which accepts only displayName, so the text was always dropped.
ALTER TABLE "ConsumerProfile" ADD COLUMN "deliveryNotes" TEXT;

-- The KYC screen uploads three documents (FSSAI licence, GSTIN certificate,
-- authorised-purchaser ID) but had a single column to store them in:
-- `aadhaarRef` took whichever of docRef/aadhaarRef arrived, so one upload
-- overwrote the other and the GSTIN file was dropped entirely. Give each its
-- own column. `aadhaarRef` is kept for backwards compatibility.
ALTER TABLE "ConsumerProfile" ADD COLUMN "fssaiDocRef" TEXT;
ALTER TABLE "ConsumerProfile" ADD COLUMN "gstinDocRef" TEXT;
ALTER TABLE "ConsumerProfile" ADD COLUMN "idProofRef" TEXT;

-- Preserve whatever single ref was already captured as the ID proof.
UPDATE "ConsumerProfile" SET "idProofRef" = "aadhaarRef" WHERE "aadhaarRef" IS NOT NULL;
