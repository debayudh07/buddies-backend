# Buddies Backend

Express + TypeScript modular monolith. **Database = Supabase Postgres**. **Cache/queues = Redis** (local Docker for now; Upstash later). Push = Firebase FCM only.

## Why PostgreSQL?

Supabase **is** PostgreSQL. We are not running a second database product. Prisma talks to the same Postgres instance Supabase hosts. Auth/Storage/Realtime stay on Supabase APIs; domain tables live in `public` (or your schema) on that Postgres.

```
Flutter  →  supabase_flutter (Auth/Storage)
Flutter  →  Express /v1  →  Prisma  →  Supabase Postgres
Express  →  firebase-admin  →  FCM
```

## Apply schema to Supabase

1. Create a Supabase project  
2. **Project Settings → Database** — copy:
   - **Connection string (URI)** with pooler → `DATABASE_URL` (port `6543`, add `?pgbouncer=true`)
   - **Direct connection** → `DIRECT_URL` (port `5432`, for migrations)
3. Put them in `.env` (see `.env.example`)
4. From `backend/`:

```bash
npm install
npx prisma generate
npx prisma db push      # creates tables in Supabase Postgres
npm run prisma:seed     # matrices + support articles
npm run dev
```

Or create a versioned migration:

```bash
npx prisma migrate dev --name init
```

Tables appear under **Supabase → Table Editor**. Enable Realtime on `ChatMessage` / `TrackingPoint` later if you subscribe from Flutter via `supabase_flutter`.

## Quick start

```bash
cd backend
cp .env.example .env
# fill SUPABASE_* and DATABASE_URL / DIRECT_URL from Supabase dashboard
npm install
npx prisma generate
npx prisma db push
npm run prisma:seed
npm run dev
```

### Docker (API + local Redis)

Supabase (Postgres/Auth/Storage) stays in the cloud. Compose runs **api + Redis** together:

```bash
# .env filled with Supabase + FCM (use FIREBASE_SERVICE_ACCOUNT_JSON in containers)
docker compose up --build
```

- API: `http://localhost:8000`
- Redis hostname inside the network: `redis` (`REDIS_URL=redis://redis:6379` is set by compose)

Redis only (while using `npm run dev` on the host):

```bash
docker compose up -d redis
```

Health: `GET http://localhost:8000/health`  
OpenAPI: `GET http://localhost:8000/openapi.yaml`

## Auth

- Production: Supabase JWT `Authorization: Bearer <access_token>`
- Dev: `Authorization: Bearer dev:consumer:<uuid>` (`DEV_AUTH_BYPASS=true`)

## Modules

| Path prefix | Domain |
|-------------|--------|
| `/v1/uploads*` | Supabase Storage (KYC, returns, chat, payments, challans) |
| `/v1` identity, devices, privacy | Auth session / profiles |
| `/v1/supplier/kyc*` | Supplier KYC + verify |
| `/v1/subscriptions*` | ₹299 plans + bid quotas |
| `/v1/consumer/bid-requests*` | Demand + reorder |
| `/v1/supplier/bidzone`, `/v1/supplier/bids*` | Bidzone |
| `/v1/orders*` | Status, GPS, digital challan, GST invoice, offline pay |
| `/v1/orders/:id/chat*` | Order chat |
| `/v1/return*`, `/v1/returns/*` | Returns engine |
| `/v1/support/*` | Dynamic FAQ CMS + tickets |

## Socket.IO

`join` rooms: `auction:{id}`, `chat:{id}`, `tracking:{id}`, `bidzone:all`.

## Push (Firebase FCM)

1. Firebase service account JSON → `FIREBASE_SERVICE_ACCOUNT_PATH`  
2. `FCM_ENABLED=true`  
3. Flutter: `POST /v1/devices` with FCM token  

## Workers

In-process timers: auction expiry, SLA breach, stale GPS nudges.
