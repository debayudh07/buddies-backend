# Supabase = Auth + Storage + Postgres (Prisma schema is SOT for tables)

The Prisma schema in [`../prisma/schema.prisma`](../prisma/schema.prisma) is the
source of truth for **tables** in this Supabase project’s Postgres.

Supabase CLI migrations under [`migrations/`](./migrations/) own **security only**:
RLS, privileges, and Realtime authorization scaffolding — never redefine Prisma tables.

## One-time setup

1. From `backend/`, with `DATABASE_URL` + `DIRECT_URL` set:

```bash
npx prisma db push
npx prisma db seed
```

2. Apply security migrations (dashboard SQL or CLI):

```bash
# If using Supabase CLI linked to the project:
# supabase db push
# Or paste migrations/*.sql into the Supabase SQL editor (in timestamp order).
```

## Env (API host)

| Variable | Role |
|----------|------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server Storage + Broadcast (never ship to apps) |
| `SUPABASE_JWT_SECRET` | **Local JWT verify** on Express (required in production) |
| `SUPABASE_ANON_KEY` | Flutter / smoke scripts only — not used on Express hot path |

## RLS / Data API

Express uses the Postgres connection string (Prisma) for domain data — **not** PostgREST.

Migration `20260808120000_enable_rls_deny_api.sql`:

- Enables RLS on all public tables created by Prisma
- Grants **no** permissive policies for `anon` / `authenticated`
- Revokes table privileges from `anon` / `authenticated`

Service role / superuser (and typical Prisma DB roles) continue to work.

If you later expose tables via the Data API, add **row-scoped** policies with
`(select auth.uid())` ownership — never blanket `TO authenticated` without a row predicate.

## Storage

Private buckets (service-role server upload):

| Purpose | Bucket |
|---------|--------|
| KYC | `buddies-kyc` |
| Return evidence | `buddies-returns` |
| Chat images | `buddies-chat` |
| Payment screenshots | `buddies-payments` |
| Challan signatures | `buddies-challans` |
| Profile avatars | `buddies-profiles` |

API:

- `POST /v1/uploads?purpose=…` — multipart `file` → `{ storageRef, signedUrl, … }`
- `GET /v1/uploads/signed-url?storageRef=…` — **ACL-gated** refresh
- Path convention: `{userId}/{purpose}/{uuid}.ext`

Persist `storageRef` (`bucket/object/path`). Buckets are created on API boot if missing
(prefer pre-create in production).

## Realtime

Live updates: **Supabase Realtime private Broadcast** (not `postgres_changes`).

Express publishes after Prisma writes (service role). Flutter subscribes with the user JWT
via `supabase_flutter`. Topics:

| Topic | Events |
|-------|--------|
| `auction:{bidRequestId}` | `auction.bid_*`, `order.created`, … |
| `chat:{threadId}` | `chat.message_created`, … |
| `tracking:{orderId}` | `order.status_changed`, `tracking.location_updated` |
| `bidzone:{geoKey}` | `demand.request_created` |
| `user:{userId}` | `notify.created` |

Socket.IO may dual-publish during cutover; production target is Realtime-only clients.
