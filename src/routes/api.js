import { z } from 'zod';
import { cacheGet, cacheSet } from '../db/redis.js';
import {
  buscarProductos, buscarPorEAN, getHistorialPrecios,
  getEstadisticasPrecios, getOfertas, crearAlerta, getStats,
} from '../services/preciosDB.js';
import { scrapeartodos, verificarYDispararAlertas } from '../workers/scrapeWorker.js';
import { logger } from '../utils/logger.js';

export async function registrarRutas(app) {

  // ─── Health check ───────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }));

  app.get('/stats', async () => {
    const stats = await getStats();
    return { ok: true, data: stats };
  });

  // ─── Búsqueda de productos ──────────────────────────────────────────────────

  app.get('/v1/products/search', {
    schema: {
      querystring: z.object({
        q:      z.string().min(2).max(100),
        limit:  z.coerce.number().int().min(1).max(50).default(20),
      }),
    },
  }, async (req, reply) => {
    const { q, limit } = req.query;
    const cacheKey = `busqueda:${q.toLowerCase().trim()}:${limit}`;

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return reply.header('X-Cache', 'HIT').send({ ok: true, data: cached, cached: true });
    }

    const productos = await buscarProductos(q, limit);

    // Agrupar por supermercado
    const porSuper = {};
    productos.forEach(p => {
      if (!porSuper[p.super_id]) {
        porSuper[p.super_id] = { superId: p.super_id, superNombre: p.super_nombre, superColor: p.super_color, productos: [] };
      }
      porSuper[p.super_id].productos.push(p);
    });

    const resultado = Object.values(porSuper);
    await cacheSet(cacheKey, resultado, 'BUSQUEDA');

    return { ok: true, data: resultado, cached: false, total: productos.length };
  });

  // ─── Buscar por EAN ─────────────────────────────────────────────────────────

  app.get('/v1/products/ean/:ean', async (req, reply) => {
    const { ean } = req.params;
    if (!/^\d{8,14}$/.test(ean)) {
      return reply.status(400).send({ ok: false, error: 'EAN inválido' });
    }

    const cacheKey = `ean:${ean}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return reply.header('X-Cache', 'HIT').send({ ok: true, data: cached });

    const productos = await buscarPorEAN(ean);
    await cacheSet(cacheKey, productos, 'PRODUCTO');

    return { ok: true, data: productos };
  });

  // ─── Historial de precios ───────────────────────────────────────────────────

  app.get('/v1/products/:productId/prices', async (req, reply) => {
    const { productId } = req.params;
    const { super_id, dias = 90 } = req.query;

    if (!super_id) {
      return reply.status(400).send({ ok: false, error: 'super_id requerido' });
    }

    const cacheKey = `historial:${productId}:${super_id}:${dias}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return reply.header('X-Cache', 'HIT').send({ ok: true, data: cached });

    const [historial, stats] = await Promise.all([
      getHistorialPrecios(productId, super_id, parseInt(dias)),
      getEstadisticasPrecios(productId, super_id),
    ]);

    const data = { historial, stats };
    await cacheSet(cacheKey, data, 'PRODUCTO');

    return { ok: true, data };
  });

  // ─── Ofertas ────────────────────────────────────────────────────────────────

  app.get('/v1/offers', async (req, reply) => {
    const { super_id, limit = 50 } = req.query;
    const cacheKey = `ofertas:${super_id ?? 'all'}:${limit}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return reply.header('X-Cache', 'HIT').send({ ok: true, data: cached });

    const ofertas = await getOfertas(super_id ?? null, parseInt(limit));
    await cacheSet(cacheKey, ofertas, 'OFERTAS');

    return { ok: true, data: ofertas, total: ofertas.length };
  });

  // ─── Alertas ────────────────────────────────────────────────────────────────

  const AlertaSchema = z.object({
    device_token:    z.string().min(10),
    producto_id:     z.string().min(1),
    super_id:        z.string().optional(),
    precio_objetivo: z.number().positive(),
  });

  app.post('/v1/alerts', async (req, reply) => {
    const parsed = AlertaSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: parsed.error.issues });
    }

    const { device_token, producto_id, super_id, precio_objetivo } = parsed.data;
    const id = await crearAlerta({
      deviceToken:    device_token,
      productoId:     producto_id,
      superId:        super_id ?? null,
      precioObjetivo: precio_objetivo,
    });

    return reply.status(201).send({ ok: true, data: { id } });
  });

  // ─── Admin: scraping manual ─────────────────────────────────────────────────

  app.post('/admin/scrape', {
    preHandler: async (req, reply) => {
      const key = req.headers['x-api-key'];
      if (key !== process.env.API_KEY) {
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }
    },
  }, async (req) => {
    const { categorias } = req.body ?? {};
    logger.info({ categorias }, 'Scraping manual iniciado');

    // Correr en background
    scrapeartodos(categorias).catch(err =>
      logger.error({ err }, 'Error en scraping manual')
    );

    return { ok: true, message: 'Scraping iniciado en background' };
  });

  // ─── Admin: verificar alertas manual ───────────────────────────────────────

  app.post('/admin/check-alerts', {
    preHandler: async (req, reply) => {
      if (req.headers['x-api-key'] !== process.env.API_KEY) {
        return reply.status(401).send({ ok: false, error: 'Unauthorized' });
      }
    },
  }, async () => {
    const disparadas = await verificarYDispararAlertas();
    return { ok: true, data: { disparadas } };
  });

}
