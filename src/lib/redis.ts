import Redis from 'ioredis';
import { config } from '../config';

let redis: Redis | null = null;
let connecting: Promise<void> | null = null;

/** Local (`redis://`) or cloud (`rediss://` TLS, e.g. Upstash). */
export function getRedis(): Redis | null {
  if (!config.redisUrl) return null;
  if (redis) return redis;

  try {
    const isTls = config.redisUrl.startsWith('rediss://');
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      enableOfflineQueue: true,
      tls: isTls ? { rejectUnauthorized: false } : undefined,
    });
    redis.on('error', (err) => {
      if (config.env === 'development') {
        console.warn('[redis]', err.message);
      }
    });
    redis.on('connect', () => {
      console.log(`[redis] connected (${isTls ? 'cloud/tls' : 'local'})`);
    });
    connecting = redis
      .connect()
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    redis = null;
  }
  return redis;
}

async function readyClient(): Promise<Redis | null> {
  const r = getRedis();
  if (!r) return null;
  if (connecting) await connecting;
  return r;
}

export async function redisGet(key: string): Promise<string | null> {
  const r = await readyClient();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch {
    return null;
  }
}

export async function redisSet(key: string, value: string, ttlSec?: number): Promise<void> {
  const r = await readyClient();
  if (!r) return;
  try {
    if (ttlSec) await r.set(key, value, 'EX', ttlSec);
    else await r.set(key, value);
  } catch {
    /* ignore */
  }
}

export async function redisPing(): Promise<boolean> {
  const r = await readyClient();
  if (!r) return false;
  try {
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  }
}
