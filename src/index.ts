import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { initSocket } from './socket';
import { startWorkers } from './workers';
import { getRedis } from './lib/redis';
import { connectDatabase } from './lib/prisma';
import { ensureStorageBuckets } from './lib/storage';
import { initFirebase } from './lib/notify';
import { logger } from './lib/logger';

async function main() {
  logger.info('boot', 'Starting Buddies API', {
    env: config.env,
    port: config.port,
    supabaseUrl: config.supabaseUrl || '(missing)',
    fcm: config.fcmEnabled,
    redis: config.redisUrl ? 'configured' : 'missing',
  });

  await connectDatabase();
  await ensureStorageBuckets();
  initFirebase();

  const app = createApp();
  const server = http.createServer(app);
  initSocket(server);
  getRedis(); // best-effort
  startWorkers();

  server.listen(config.port, () => {
    logger.info('boot', `listening on :${config.port}`);
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
