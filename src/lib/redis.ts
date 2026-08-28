import Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

let redis: Redis | null = null;
let connecting: Promise<void> | null = null;
let lastError: string | null = null;
let connected = false;

function redisHostLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === 'rediss:' ? '6379' : '6379')}`;
  } catch {
    return '(unparseable REDIS_URL)';
  }
}

/** Local (`redis://`) or cloud (`rediss://` TLS, e.g. Upstash). */
export function getRedis(): Redis | null {
  if (!config.redisUrl) return null;
  if (redis) return redis;

  try {
    const isTls = config.redisUrl.startsWith('rediss://');
    const host = redisHostLabel(config.redisUrl);
    logger.info('redis', 'connecting…', { host, tls: isTls });

    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: true,
      connectTimeout: 10_000,
      tls: isTls ? { rejectUnauthorized: false } : undefined,
    });

    redis.on('error', (err) => {
      connected = false;
      lastError = err.message;
      logger.warn('redis', 'error', { message: err.message, host });
    });
    redis.on('connect', () => {
      logger.info('redis', 'TCP connected', { host, tls: isTls });
    });
    redis.on('ready', () => {
      connected = true;
      lastError = null;
      logger.info('redis', 'ready (commands OK)', { host, tls: isTls });
    });
    redis.on('close', () => {
      connected = false;
      logger.warn('redis', 'connection closed', { host });
    });
    redis.on('reconnecting', () => {
      connected = false;
      logger.info('redis', 'reconnecting…', { host });
    });

    connecting = redis
      .connect()
      .then(() => undefined)
      .catch((err: unknown) => {
        connected = false;
        lastError = err instanceof Error ? err.message : String(err);
        logger.error('redis', 'connect() failed', { message: lastError, host });
      });
  } catch (err) {
    redis = null;
    connected = false;
    lastError = err instanceof Error ? err.message : String(err);
    logger.error('redis', 'client init failed', { message: lastError });
  }
  return redis;
}

async function readyClient(): Promise<Redis | null> {
  const r = getRedis();
  if (!r) return null;
  if (connecting) await connecting;
  return r;
}

/** Await connect + PING; log clear OK / fail. Call once at boot. */
export async function connectRedis(): Promise<boolean> {
  if (!config.redisUrl) {
    logger.warn('redis', 'REDIS_URL missing — cache disabled');
    return false;
  }

  const host = redisHostLabel(config.redisUrl);
  const started = Date.now();
  try {
    const r = await readyClient();
    if (!r) {
      logger.error('redis', 'not connected', { host, error: lastError ?? 'no client' });
      return false;
    }
    const pong = await r.ping();
    if (pong !== 'PONG') {
      connected = false;
      lastError = `unexpected ping reply: ${pong}`;
      logger.error('redis', 'ping failed', { host, reply: pong });
      return false;
    }
    connected = true;
    lastError = null;
    logger.info('redis', 'connected OK', {
      host,
      tls: config.redisUrl.startsWith('rediss://'),
      ms: Date.now() - started,
      ping: pong,
    });
    return true;
  } catch (err) {
    connected = false;
    lastError = err instanceof Error ? err.message : String(err);
    logger.error('redis', 'not connected', {
      host,
      error: lastError,
      ms: Date.now() - started,
    });
    return false;
  }
}

export function getRedisStatus(): {
  configured: boolean;
  connected: boolean;
  host: string | null;
  tls: boolean;
  lastError: string | null;
} {
  return {
    configured: Boolean(config.redisUrl),
    connected,
    host: config.redisUrl ? redisHostLabel(config.redisUrl) : null,
    tls: Boolean(config.redisUrl?.startsWith('rediss://')),
    lastError,
  };
}

export async function redisGet(key: string): Promise<string | null> {
  const r = await readyClient();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('redis', 'GET failed', { key, error: lastError });
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSec?: number): Promise<void> {
  const r = await readyClient();
  if (!r) return;
  try {
    if (ttlSec) await r.set(key, value, 'EX', ttlSec);
    else await r.set(key, value);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('redis', 'SET failed', { key, error: lastError });
  }
}

export async function redisDelPrefix(prefix: string): Promise<void> {
  const r = await readyClient();
  if (!r) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 80);
      cursor = next;
      if (keys.length > 0) await r.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.warn('redis', 'DEL prefix failed', { prefix, error: lastError });
  }
}

export async function redisPing(): Promise<boolean> {
  const r = await readyClient();
  if (!r) return false;
  try {
    const ok = (await r.ping()) === 'PONG';
    connected = ok;
    return ok;
  } catch (err) {
    connected = false;
    lastError = err instanceof Error ? err.message : String(err);
    return false;
  }
}
