import 'dotenv/config';

const env = process.env.NODE_ENV ?? 'development';
const isProd = env === 'production';
const devAuthBypass = process.env.DEV_AUTH_BYPASS === 'true';

if (isProd && devAuthBypass) {
  throw new Error('FATAL: DEV_AUTH_BYPASS must be false when NODE_ENV=production');
}

if (isProd) {
  for (const key of [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_JWT_SECRET',
  ] as const) {
    if (!process.env[key]) {
      throw new Error(`FATAL: ${key} is required when NODE_ENV=production`);
    }
  }
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  env,
  isProd,
  port: Number(process.env.PORT ?? 8000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
  /** Staging only. Forced off in production. */
  devAuthBypass: isProd ? false : devAuthBypass,
  /** Empty = reflect request origin in dev; in prod must be set. */
  allowedOrigins,
  auction: {
    baseWindowSec: Number(process.env.AUCTION_BASE_WINDOW_SEC ?? 600),
    autoExtendTriggerSec: Number(process.env.AUCTION_AUTO_EXTEND_TRIGGER_SEC ?? 60),
    autoExtendBySec: Number(process.env.AUCTION_AUTO_EXTEND_BY_SEC ?? 120),
    maxExtends: Number(process.env.AUCTION_MAX_EXTENDS ?? 5),
    minDecrementPaise: Number(process.env.AUCTION_MIN_DECREMENT_PAISE ?? 10000),
    /**
     * Max lifetime of a single supplier bid after placement (default 5 minutes).
     * actual expiresAt = min(RFQ liveEndsAt, now + bidTtlSec).
     */
    bidTtlSec: Number(process.env.BID_TTL_SEC ?? 300),
    /**
     * Seconds after RFQ create during which consumer may rewrite line items.
     * Address / delivery window stay editable while the auction is still open.
     */
    itemsEditWindowSec: Number(process.env.BID_REQUEST_ITEMS_EDIT_SEC ?? 30),
  },
  /**
   * Self-ping to stop a free-tier host (Render) idling the instance out.
   *
   * Render spins a free service down after ~15 minutes with no inbound request,
   * and the next caller pays a cold start. A request to our own public URL is
   * inbound traffic, so polling it on a shorter interval keeps the dyno warm.
   *
   * Caveat worth knowing: this only *prevents* sleep. Once the process is down
   * nothing inside it can wake it, so a deploy or crash still cold-starts the
   * next real request. An external pinger is the only way to cover that.
   *
   * `url` is usually unnecessary on Render, which injects RENDER_EXTERNAL_URL.
   */
  keepAlive: {
    enabled: process.env.KEEPALIVE_ENABLED
      ? process.env.KEEPALIVE_ENABLED === 'true'
      : isProd,
    url: (
      process.env.KEEPALIVE_URL ??
      process.env.RENDER_EXTERNAL_URL ??
      ''
    ).replace(/\/+$/, ''),
    /** Must stay comfortably under the host's idle timeout (~15 min on Render). */
    intervalSec: Number(process.env.KEEPALIVE_INTERVAL_SEC ?? 600),
    /**
     * Optional "HH-HH" local-hour window, e.g. "6-23", to stay inside the free
     * 750 instance-hours/month budget. Empty = around the clock.
     */
    activeHours: process.env.KEEPALIVE_ACTIVE_HOURS ?? '',
  },
  slaHours: Number(process.env.SLA_HOURS ?? 8),
  inspectionWindowSec: Number(process.env.INSPECTION_WINDOW_SEC ?? 600),
  trackingStaleSec: Number(process.env.TRACKING_STALE_SEC ?? 120),
  /** Push only — Auth/DB stay on Supabase. Uses firebase-admin → FCM. */
  fcmEnabled: process.env.FCM_ENABLED === 'true',
  firebaseServiceAccountPath:
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ??
    './secrets/firebase-service-account.json',
  handoff: {
    /** Order-scoped delivery link default lifetime (ms). */
    defaultTtlMs: Number(process.env.HANDOFF_TTL_MS ?? 48 * 60 * 60 * 1000),
    /** Custom app scheme URL prefix (deep link). */
    appScheme: process.env.HANDOFF_APP_SCHEME ?? 'com.buddies.buddies-supplier://handoff',
    /**
     * HTTPS landing that tries to open the app and falls back to the store.
     * Set HANDOFF_WEB_BASE to your public host (e.g. https://buddies.app/d).
     */
    webBase: process.env.HANDOFF_WEB_BASE ?? '',
  },
};
