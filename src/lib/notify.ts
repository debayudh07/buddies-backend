import fs from 'fs';
import path from 'path';
import { applicationDefault, cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type BatchResponse, type MulticastMessage } from 'firebase-admin/messaging';
import { config } from '../config';
import { prisma } from './prisma';
import { logger } from './logger';

type NotifyPayload = {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
};

let app: App | null = null;
let initAttempted = false;

function resolveCredentialPath(raw: string): string {
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** Initialize Firebase Admin for FCM. Safe to call multiple times. */
export function initFirebase(): boolean {
  if (app) return true;
  if (initAttempted) return Boolean(app);
  initAttempted = true;

  if (!config.fcmEnabled) {
    logger.info('fcm', 'disabled (FCM_ENABLED!=true)');
    return false;
  }

  try {
    const existing = getApps();
    if (existing.length > 0) {
      app = existing[0]!;
      logger.info('fcm', 'using existing Firebase app');
      return true;
    }

    const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const credPathRaw = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? config.firebaseServiceAccountPath;
    const credPath = credPathRaw ? resolveCredentialPath(credPathRaw) : '';

    if (credJson) {
      const parsed = JSON.parse(credJson) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      app = initializeApp({
        credential: cert({
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        }),
      });
    } else if (credPath && fs.existsSync(credPath)) {
      const parsed = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      app = initializeApp({
        credential: cert({
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        }),
      });
      logger.info('fcm', 'initialized from service account file', {
        path: credPath,
        projectId: parsed.project_id,
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      app = initializeApp({ credential: applicationDefault() });
      logger.info('fcm', 'initialized via application default credentials');
    } else {
      logger.warn('fcm', 'FCM_ENABLED=true but no credentials found', {
        lookedFor: credPath || '(none)',
      });
      return false;
    }

    return true;
  } catch (e) {
    logger.error('fcm', 'init failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    app = null;
    return false;
  }
}

export function isFirebaseReady(): boolean {
  return app !== null || (initAttempted && getApps().length > 0);
}

/** Send push via Firebase Cloud Messaging (device tokens from DeviceToken table). */
export async function sendPush(payload: NotifyPayload): Promise<void> {
  if (!config.fcmEnabled) {
    logger.debug('fcm', 'stub (disabled)', {
      userId: payload.userId,
      title: payload.title,
    });
    return;
  }

  const ready = initFirebase();
  const tokens = await prisma.deviceToken.findMany({
    where: { userId: payload.userId },
    select: { id: true, token: true },
  });

  if (tokens.length === 0) {
    logger.info('fcm', 'no device tokens', { userId: payload.userId, title: payload.title });
    return;
  }

  if (!ready || !app) {
    logger.warn('fcm', 'stub — firebase not ready', {
      userId: payload.userId,
      title: payload.title,
      tokens: tokens.length,
    });
    return;
  }

  const message: MulticastMessage = {
    tokens: tokens.map((t: { id: string; token: string }) => t.token),
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  let result: BatchResponse;
  try {
    result = await getMessaging(app).sendEachForMulticast(message);
  } catch (e) {
    logger.error('fcm', 'send failed', {
      userId: payload.userId,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const stale: string[] = [];
  const errors: string[] = [];
  result.responses.forEach((r, i) => {
    if (!r.error) return;
    errors.push(r.error.code);
    if (
      r.error.code === 'messaging/registration-token-not-registered' ||
      r.error.code === 'messaging/invalid-registration-token'
    ) {
      stale.push(tokens[i]!.id);
    }
  });
  if (stale.length) {
    await prisma.deviceToken.deleteMany({ where: { id: { in: stale } } });
  }

  logger.info('fcm', 'send result', {
    userId: payload.userId,
    success: result.successCount,
    failure: result.failureCount,
    errors: errors.length ? errors : undefined,
    prunedInvalidTokens: stale.length || undefined,
  });
}

export async function notifyMany(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
) {
  await Promise.all(userIds.map((userId) => sendPush({ userId, title, body, data })));
}
