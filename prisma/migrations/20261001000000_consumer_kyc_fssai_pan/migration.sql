-- The consumer KYC form has always collected the FSSAI licence and business PAN,
-- but there was nowhere to store them: the Zod schema dropped both keys silently,
-- so every submitted value was discarded. Add the columns so they persist.
ALTER TABLE "ConsumerProfile" ADD COLUMN "fssai" TEXT;
ALTER TABLE "ConsumerProfile" ADD COLUMN "pan" TEXT;

-- Same problem for the Edit Profile screen's delivery-notes box: it was POSTed
-- to PATCH /me, which accepts only displayName, so the text was always dropped.
ALTER TABLE "ConsumerProfile" ADD COLUMN "deliveryNotes" TEXT;
