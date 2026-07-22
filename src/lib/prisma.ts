import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const logQueries = process.env.PRISMA_LOG_QUERIES === 'true';

export const prisma = new PrismaClient({
  log: logQueries ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/** Verify Supabase Postgres reachability via Prisma. */
export async function connectDatabase(): Promise<void> {
  const started = Date.now();
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    logger.info('db', 'Supabase Postgres connected via Prisma', {
      ms: Date.now() - started,
      urlHost: safeDbHost(process.env.DATABASE_URL),
    });
  } catch (err) {
    logger.error('db', 'Supabase Postgres connection failed', {
      ms: Date.now() - started,
      urlHost: safeDbHost(process.env.DATABASE_URL),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function safeDbHost(url?: string): string {
  if (!url) return '(missing DATABASE_URL)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}
