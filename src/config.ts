import 'dotenv/config';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET ?? '',
  devAuthBypass: process.env.DEV_AUTH_BYPASS === 'true',
  auction: {
    baseWindowSec: Number(process.env.AUCTION_BASE_WINDOW_SEC ?? 600),
    autoExtendTriggerSec: Number(process.env.AUCTION_AUTO_EXTEND_TRIGGER_SEC ?? 60),
    autoExtendBySec: Number(process.env.AUCTION_AUTO_EXTEND_BY_SEC ?? 120),
    maxExtends: Number(process.env.AUCTION_MAX_EXTENDS ?? 5),
    minDecrementPaise: Number(process.env.AUCTION_MIN_DECREMENT_PAISE ?? 10000),
  },
  slaHours: Number(process.env.SLA_HOURS ?? 8),
  inspectionWindowSec: Number(process.env.INSPECTION_WINDOW_SEC ?? 600),
  trackingStaleSec: Number(process.env.TRACKING_STALE_SEC ?? 120),
  /** Push only — Auth/DB stay on Supabase. Uses firebase-admin → FCM. */
  fcmEnabled: process.env.FCM_ENABLED === 'true',
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? '',
};
