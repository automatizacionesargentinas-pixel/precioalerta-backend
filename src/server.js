import 'dotenv/config';
import Fastify       from 'fastify';
import cors          from '@fastify/cors';
import helmet        from '@fastify/helmet';
import rateLimit     from '@fastify/rate-limit';
import { registrarRutas }   from './routes/api.js';
import { registrarCronJobs } from './workers/scrapeWorker.js';
import { testConnection }    from './db/pool.js';
import { testRedis }         from './db/redis.js';
import { logger }            from './utils/logger.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize// : true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

await app.register(helmet, {
  contentSecurityPolicy: false,
});

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'DELETE'],
});

await app.register(rateLimit, {
  max:     parseInt(process.env.RATE_LIMIT_MAX        ?? '100'),
  timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
  errorResponseBuilder: () => ({
    ok: false, error: 'Demasiadas requests. Esperá un momento.',
  }),
});

// ─── Schema validator personalizado para Zod ─────────────────────────────────

app.setValidatorCompiler(({ schema }) => {
  return (data) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return { error: result.error };
  };
});

app.setErrorHandler((error, req, reply) => {
  if (error.statusCode === 429) return reply.status(429).send(error);

  logger.error({ url: req.url, method: req.method, err: error.message }, 'Request error');

  if (error.validation) {
    return reply.status(400).send({ ok: false, error: 'Parámetros inválidos', details: error.validation });
  }

  reply.status(error.statusCode ?? 500).send({
    ok: false,
    error: process.env.NODE_ENV === 'production' ? 'Error interno' : error.message,
  });
});

// ─── Rutas ────────────────────────────────────────────────────────────────────

await registrarRutas(app);

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Verificar conexiones
    const dbOk    = await testConnection();
    const redisOk = await testRedis();

    if (!dbOk) {
      logger.error('No se pudo conectar a PostgreSQL. Verificá DATABASE_URL.');
      process.exit(1);
    }

    if (!redisOk) {
      logger.warn('Redis no disponible — operando sin caché.');
    }

    // Registrar cron jobs
    registrarCronJobs();

    // Iniciar servidor
    const host = process.env.HOST ?? '0.0.0.0';
    const port = parseInt(process.env.PORT ?? '3000');

    await app.listen({ host, port });

    logger.info({
      host, port,
      env: process.env.NODE_ENV,
      db: dbOk ? '✅' : '❌',
      redis: redisOk ? '✅' : '⚠️',
    }, '🚀 PrecioAlerta AR Backend corriendo');

  } catch (err) {
    logger.error({ err }, 'Error iniciando servidor');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recibido — cerrando servidor...');
  await app.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recibido — cerrando servidor...');
  await app.close();
  process.exit(0);
});

start();
