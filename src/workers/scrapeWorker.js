import cron from 'node-cron';
import { scrapeVtex }    from '../services/scraperVtex.js';
import { scrapeCoto }    from '../services/scraperCoto.js';
import { guardarBatch, getAlertasDisparadas, marcarAlertaDisparada } from '../services/preciosDB.js';
import { enviarNotificacion } from '../services/fcm.js';
import { query }         from '../db/pool.js';
import { cacheDelPattern } from '../db/redis.js';
import { logger }        from '../utils/logger.js';

// ─── Categorías a scrapear ────────────────────────────────────────────────────

const CATEGORIAS = [
  'lacteos', 'leche', 'yogurt',
  'panificados', 'pan', 'galletitas',
  'bebidas', 'agua', 'gaseosas', 'jugos',
  'carnes', 'pollo', 'carne vacuna',
  'frutas y verduras',
  'almacen', 'arroz', 'fideos', 'aceite', 'azucar', 'harina', 'yerba',
  'limpieza', 'detergente', 'lavandina',
  'higiene personal', 'shampoo', 'jabon',
  'congelados',
];

const SUPERS_VTEX = [
  { id: 'dia',       base: 'https://diaonline.supermercadosdia.com.ar' },
  { id: 'carrefour', base: 'https://www.carrefour.com.ar' },
  { id: 'jumbo',     base: 'https://www.jumbo.com.ar' },
  { id: 'disco',     base: 'https://www.disco.com.ar' },
  { id: 'changomas', base: 'https://www.masonline.com.ar' },
  { id: 'vea',       base: 'https://www.vea.com.ar' },
];

// ─── Función principal de scraping ───────────────────────────────────────────

async function scrapearSuper(superId, baseUrl, tipo, categorias) {
  const logId = await iniciarLog(superId);
  const inicio = Date.now();
  let totalProductos = 0, totalNuevos = 0, totalErrores = 0;

  logger.info({ superId, categorias: categorias.length }, 'Iniciando scraping');

  for (const cat of categorias) {
    try {
      const { productos, errores } = tipo === 'coto'
        ? await scrapeCoto(cat, 3)
        : await scrapeVtex(baseUrl, superId, cat, 3);

      if (productos.length) {
        const { guardados, preciosCambiados } = await guardarBatch(productos);
        totalProductos += guardados;
        totalNuevos    += preciosCambiados;
        totalErrores   += errores;
      }
    } catch (err) {
      logger.error({ superId, cat, err: err.message }, 'Error scrapeando categoría');
      totalErrores++;
    }
  }

  const duracion = Date.now() - inicio;
  await finalizarLog(logId, totalProductos, totalNuevos, totalErrores, duracion);

  // Invalidar caché de búsquedas para este super
  await cacheDelPattern(`busqueda:*`);
  await cacheDelPattern(`ofertas:${superId}:*`);

  logger.info({ superId, totalProductos, totalNuevos, totalErrores, duracion }, 'Scraping finalizado');
  return { totalProductos, totalNuevos, totalErrores };
}

// ─── Scraping de todos los supers ────────────────────────────────────────────

export async function scrapeartodos(categorias = CATEGORIAS) {
  logger.info({ supers: SUPERS_VTEX.length + 1, categorias: categorias.length }, 'Scraping masivo iniciado');

  const resultados = await Promise.allSettled([
    ...SUPERS_VTEX.map(s => scrapearSuper(s.id, s.base, 'vtex', categorias)),
    scrapearSuper('coto', null, 'coto', categorias),
  ]);

  const resumen = resultados.map((r, i) => ({
    super: i < SUPERS_VTEX.length ? SUPERS_VTEX[i].id : 'coto',
    ...(r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
  }));

  logger.info({ resumen }, 'Scraping masivo completado');
  return resumen;
}

// ─── Worker de alertas ───────────────────────────────────────────────────────

export async function verificarYDispararAlertas() {
  try {
    const alertas = await getAlertasDisparadas();
    if (!alertas.length) return 0;

    logger.info({ cantidad: alertas.length }, 'Alertas disparadas encontradas');

    for (const alerta of alertas) {
      try {
        await enviarNotificacion(alerta.device_token, {
          title: `🏷️ ¡Bajó el precio! — ${alerta.super_nombre}`,
          body:  `${alerta.nombre} ahora cuesta $${Math.round(alerta.precio_actual).toLocaleString('es-AR')}. Tu objetivo era $${Math.round(alerta.precio_objetivo).toLocaleString('es-AR')}.`,
          data:  {
            tipo:         'alerta_precio',
            productoId:   alerta.producto_id,
            superId:      alerta.super_precio,
            precioActual: alerta.precio_actual,
          },
        });
        await marcarAlertaDisparada(alerta.id, alerta.precio_actual);
      } catch (err) {
        logger.warn({ alertaId: alerta.id, err: err.message }, 'Error enviando notificación');
      }
    }

    return alertas.length;
  } catch (err) {
    logger.error({ err }, 'Error verificando alertas');
    return 0;
  }
}

// ─── Helpers de log ───────────────────────────────────────────────────────────

async function iniciarLog(superId) {
  const res = await query(
    `INSERT INTO scrape_logs (super_id) VALUES ($1) RETURNING id`,
    [superId]
  );
  return res.rows[0].id;
}

async function finalizarLog(id, total, nuevos, errores, duracion) {
  await query(`
    UPDATE scrape_logs
    SET productos_total=$2, precios_nuevos=$3, errores=$4, duracion_ms=$5, finalizado_en=NOW()
    WHERE id=$1
  `, [id, total, nuevos, errores, duracion]);
}

// ─── Registrar cron jobs ──────────────────────────────────────────────────────

export function registrarCronJobs() {
  const cronPrecios  = process.env.CRON_PRECIOS  ?? '0 */6 * * *';
  const cronOfertas  = process.env.CRON_OFERTAS  ?? '0 */2 * * *';
  const cronAlertas  = process.env.CRON_ALERTAS  ?? '*/30 * * * *';

  // Scraping completo cada 6 horas
  cron.schedule(cronPrecios, async () => {
    logger.info('CRON: Scraping completo iniciado');
    await scrapeartodos(CATEGORIAS);
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Scraping de ofertas cada 2 horas (solo categorías prioritarias)
  const catOfertas = ['lacteos', 'almacen', 'bebidas', 'limpieza'];
  cron.schedule(cronOfertas, async () => {
    logger.info('CRON: Scraping de ofertas iniciado');
    await scrapeartodos(catOfertas);
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Verificar alertas cada 30 minutos
  cron.schedule(cronAlertas, async () => {
    const disparadas = await verificarYDispararAlertas();
    if (disparadas > 0) logger.info({ disparadas }, 'CRON: alertas disparadas');
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  logger.info({
    cronPrecios, cronOfertas, cronAlertas,
  }, 'Cron jobs registrados');
}
