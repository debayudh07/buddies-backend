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
import { subscriptionsRouter } from './modules/subscriptions/routes';
import { demandRouter } from './modules/demand/routes';
import { bidzoneRouter } from './modules/bidzone/routes';
import { ordersRouter } from './modules/orders/routes';
import { messagingRouter } from './modules/messaging/routes';
import { returnsRouter } from './modules/returns/routes';
import { supportRouter } from './modules/support/routes';
import { uploadsRouter } from './modules/uploads/routes';
import { isFirebaseReady, initFirebase } from './lib/notify';
import { config } from './config';

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Compact HTTP access log (morgan) + structured request log
  app.use(morgan('dev'));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info('api', `${req.method} ${req.originalUrl}`, {
        status: res.statusCode,
        ms: Date.now() - started,
        auth: req.headers.authorization ? 'present' : 'none',
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    // Ensure FCM init has been attempted for accurate status
    if (config.fcmEnabled && !isFirebaseReady()) initFirebase();
    res.json({
      ok: true,
      service: 'buddies-api',
      version: '1.0.0',
      fcm: {
        enabled: config.fcmEnabled,
        ready: isFirebaseReady(),
      },
    });
  });

  app.use('/v1', identityRouter);
  app.use('/v1', uploadsRouter);
  app.use('/v1', kycRouter);
  app.use('/v1', subscriptionsRouter);
  app.use('/v1', demandRouter);
  app.use('/v1', bidzoneRouter);
  app.use('/v1', ordersRouter);
  app.use('/v1', messagingRouter);
  app.use('/v1', returnsRouter);
  app.use('/v1', supportRouter);

  app.get('/openapi.yaml', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'openapi', 'openapi.yaml'));
  });

  app.use(errorHandler);
  return app;
}
