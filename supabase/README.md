# Supabase = our Postgres

The Prisma schema in [`../prisma/schema.prisma`](../prisma/schema.prisma) is the source of truth for tables in **this** Supabase project’s Postgres.

## One-time setup

1. Supabase dashboard → **SQL** or just use Prisma from the API host.
2. From `backend/`:

```bash
# .env must have DATABASE_URL + DIRECT_URL from Supabase Database settings
npx prisma db push
npx prisma db seed
```

## RLS note

Express uses the **service role** / direct DB URL for privileged writes (bids, challan, returns).  
If you later expose tables to Flutter via PostgREST, add RLS policies that **deny** client writes on `Bid`, `Order`, `OfflinePayment`, `ReturnClaim`, etc., and allow read of own rows only.

Suggested (optional) starter policy mindset:

- `ConsumerProfile` / `SupplierProfile`: users read/update own row via `auth.uid() = supabaseId` mapping  
- Auction/order ledgers: no direct client insert/update

## Media (Supabase Storage)

Express uploads use the **service role** into private buckets:

| Purpose | Bucket |
|---------|--------|
| KYC | `buddies-kyc` |
| Return evidence | `buddies-returns` |
| Chat images | `buddies-chat` |
| Payment screenshots | `buddies-payments` |
| Challan signatures | `buddies-challans` |

API:

- `POST /v1/uploads?purpose=returns` — multipart field `file` → `{ storageRef, signedUrl, mediaType }`
- `GET /v1/uploads/signed-url?storageRef=bucket/path` — refresh signed URL
- `POST /v1/return-claims/:id/evidence` — can send multipart `file` directly

Persist `storageRef` (format `bucket/object/path`) on DB ref fields. Buckets are created automatically on API boot if missing.

Flutter may also upload with `supabase_flutter` Storage using the user JWT + RLS policies; then POST the resulting path as `storageRef`.
