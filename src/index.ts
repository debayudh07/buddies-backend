import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { initSocket } from './socket';
import { startWorkers } from './workers';
import { connectRedis } from './lib/redis';
import { connectDatabase } from './lib/prisma';
import { ensureStorageBuckets } from './lib/storage';
import { initFirebase } from './lib/notify';
import { logger } from './lib/logger';

async function main() {
  if (config.isProd && config.allowedOrigins.length === 0) {
    logger.warn('boot', 'ALLOWED_ORIGINS empty in production — browser CORS/Socket blocked');
  }

  logger.info('boot', 'Starting Buddies API', {
    env: config.env,
    port: config.port,
    supabaseUrl: config.supabaseUrl || '(missing)',
    fcm: config.fcmEnabled,
    redis: config.redisUrl ? 'configured' : 'missing',
    devAuthBypass: config.devAuthBypass,
    allowedOrigins: config.allowedOrigins.length || '(open-dev / none-prod)',
  });

  await connectDatabase();
  await ensureStorageBuckets();
  initFirebase();
  await connectRedis(); // logs connected OK / not connected

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);
  startWorkers();

  // Bind all interfaces so phones on the same Wi‑Fi can reach the API.
  server.listen(config.port, '0.0.0.0', () => {
    logger.info('boot', `listening on 0.0.0.0:${config.port}`);
    logger.info('boot', `Health http://localhost:${config.port}/health`);
    logger.info('boot', `OpenAPI http://localhost:${config.port}/openapi.yaml`);
    if (config.devAuthBypass) {
      logger.info('boot', 'DEV_AUTH_BYPASS on — Bearer dev:consumer:<uuid> or dev:supplier:<uuid>');
    }
  });
}

main().catch((e) => {
  logger.error('boot', 'fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
