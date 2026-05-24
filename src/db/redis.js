import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

let client = null;

export function getRedis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on('error',   err => logger.warn({ err }, 'Redis error'));
    client.on('connect', ()  => logger.info('Redis conectado'));
  }
  return client;
}

// ─── Helpers de caché ─────────────────────────────────────────────────────────

const TTL = {
  BUSQUEDA:  60 * 5,      // 5 minutos
  PRODUCTO:  60 * 10,     // 10 minutos
  OFERTAS:   60 * 30,     // 30 minutos
  RANKING:   60 * 60,     // 1 hora
};

export async function cacheGet(key) {
  try {
    const val = await getRedis().get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function cacheSet(key, value, tipo = 'BUSQUEDA') {
  try {
    await getRedis().setex(key, TTL[tipo] ?? 300, JSON.stringify(value));
  } catch {}
}

export async function cacheDel(key) {
  try { await getRedis().del(key); } catch {}
}

export async function cacheDelPattern(pattern) {
  try {
    const keys = await getRedis().keys(pattern);
    if (keys.length) await getRedis().del(...keys);
  } catch {}
}

export async function testRedis() {
  try {
    await getRedis().connect();
    await getRedis().ping();
    logger.info('Redis OK');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Redis no disponible — operando sin caché');
    return false;
  }
}
