import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max:              10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error');
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const pool = getPool();
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const ms = Date.now() - start;
    if (ms > 500) logger.warn({ sql: sql.slice(0, 80), ms }, 'Slow query');
    return result;
  } catch (err) {
    logger.error({ err, sql: sql.slice(0, 80) }, 'Query error');
    throw err;
  }
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function testConnection() {
  try {
    const res = await query('SELECT NOW() AS now');
    logger.info({ now: res.rows[0].now }, 'PostgreSQL conectado');
    return true;
  } catch (err) {
    logger.error({ err }, 'Error conectando a PostgreSQL');
    return false;
  }
}
