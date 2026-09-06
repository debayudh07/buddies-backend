import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'express-async-errors';
import path from 'path';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './lib/logger';
import { identityRouter } from './modules/identity/routes';
import { kycRouter } from './modules/supplier-kyc/routes';
import { consumerKycRouter } from './modules/consumer-kyc/routes';
import { subscriptionsRouter } from './modules/subscriptions/routes';
import { demandRouter } from './modules/demand/routes';
import { bidzoneRouter } from './modules/bidzone/routes';
import { ordersRouter } from './modules/orders/routes';
import { messagingRouter } from './modules/messaging/routes';
import { returnsRouter } from './modules/returns/routes';
import { supportRouter } from './modules/support/routes';
import { uploadsRouter } from './modules/uploads/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { dashboardRouter } from './modules/dashboard/routes';
import { catalogRouter } from './modules/catalog/routes';
import { adminRouter } from './modules/admin/routes';
import { isFirebaseReady, initFirebase } from './lib/notify';
import { getRedisStatus, redisPing } from './lib/redis';
import { config } from './config';

function corsOrigin(): cors.CorsOptions['origin'] {
  if (config.allowedOrigins.length > 0) {
    return config.allowedOrigins;
  }
  if (config.isProd) {
    // Fail closed if misconfigured — set ALLOWED_ORIGINS in production.
    return false;
  }
  return true;
}

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigin(),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  // Compact HTTP access log (morgan) + structured request log.
  // Latency budgets: reads/views ~200ms, writes ~1000ms (warn when exceeded).
  // authMs vs handlerMs: warm auth should be ~0–5ms; large handlerMs = Prisma RTT.
  app.use(morgan('dev'));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const authMs = typeof req.authMs === 'number' ? req.authMs : undefined;
      const handlerMs =
        authMs != null ? Math.max(0, ms - authMs) : undefined;
      const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const budgetMs = isRead ? 200 : 1000;
      const payload = {
        status: res.statusCode,
        ms,
        authMs,
        handlerMs,
        budgetMs,
        auth: req.headers.authorization ? 'present' : 'none',
      };
      if (ms > budgetMs) {
        logger.warn('api.slow', `${req.method} ${req.originalUrl}`, payload);
      } else {
        logger.info('api', `${req.method} ${req.originalUrl}`, payload);
      }
    });
    next();
  });

  app.get('/health', async (_req, res) => {
    if (config.fcmEnabled && !isFirebaseReady()) initFirebase();
    const redis = getRedisStatus();
    const redisPingOk = redis.configured ? await redisPing() : false;
    res.json({
      ok: true,
      service: 'buddies-api',
      version: '1.0.0',
      fcm: {
        enabled: config.fcmEnabled,
        ready: isFirebaseReady(),
      },
      redis: {
        ...redis,
        ping: redisPingOk,
      },
    });
  });

  app.use('/v1', identityRouter);
  app.use('/v1', uploadsRouter);
  app.use('/v1', kycRouter);
  app.use('/v1', consumerKycRouter);
  app.use('/v1', subscriptionsRouter);
  app.use('/v1', catalogRouter);
  app.use('/v1', demandRouter);
  app.use('/v1', bidzoneRouter);
  app.use('/v1', ordersRouter);
  app.use('/v1', messagingRouter);
  app.use('/v1', returnsRouter);
  app.use('/v1', supportRouter);
  app.use('/v1', notificationsRouter);
  app.use('/v1', dashboardRouter);
  app.use('/v1', adminRouter);

  app.get('/openapi.yaml', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'openapi', 'openapi.yaml'));
  });

  app.use(errorHandler);
  return app;
}
