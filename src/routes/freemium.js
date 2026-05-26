/**
 * Rutas de freemium, alertas y pagos — Ahorramás
 */
import { z } from 'zod';
import {
  getEstadoUsuario, crearAlertaFreemium,
  getAlertasUsuario, eliminarAlerta, activarPremium,
} from '../services/usuariosDB.js';
import { crearLinkSuscripcion, procesarWebhookMP } from '../services/mercadopago.js';
import { logger } from '../utils/logger.js';

export async function registrarRutasFreemium(app) {

  // ─── Estado del usuario ───────────────────────────────────────────────────
  app.get('/v1/user/status', {
    schema: { querystring: z.object({ device_id: z.string().min(8) }) },
  }, async (req) => {
    const estado = await getEstadoUsuario(req.query.device_id);
    return { ok: true, data: estado };
  });

  // ─── Alertas ──────────────────────────────────────────────────────────────
  app.get('/v1/alerts', {
    schema: { querystring: z.object({ device_id: z.string().min(8) }) },
  }, async (req) => {
    const alertas = await getAlertasUsuario(req.query.device_id);
    return { ok: true, data: alertas };
  });

  app.post('/v1/alerts', {
    schema: {
      body: z.object({
        device_id:      z.string().min(8),
        producto_id:    z.string(),
        super_id:       z.string().optional(),
        precio_objetivo: z.number().positive(),
        producto_nombre: z.string().optional(),
      }),
    },
  }, async (req, reply) => {
    const { device_id, producto_id, super_id, precio_objetivo } = req.body;
    const resultado = await crearAlertaFreemium({
      deviceId: device_id, productoId: producto_id,
      superId: super_id, precioObjetivo: precio_objetivo,
    });

    if (!resultado.ok && resultado.error === 'limite_alcanzado') {
      return reply.code(403).send({ ok: false, ...resultado });
    }
    return { ok: true, data: resultado };
  });

  app.delete('/v1/alerts/:id', {
    schema: {
      params: z.object({ id: z.coerce.number() }),
      querystring: z.object({ device_id: z.string().min(8) }),
    },
  }, async (req, reply) => {
    const eliminada = await eliminarAlerta(req.params.id, req.query.device_id);
    if (!eliminada) return reply.code(404).send({ ok: false, error: 'no encontrada' });
    return { ok: true };
  });

  // ─── Premium / MercadoPago ────────────────────────────────────────────────
  app.post('/v1/premium/checkout', {
    schema: {
      body: z.object({
        device_id: z.string().min(8),
        email:     z.string().email().optional(),
      }),
    },
  }, async (req) => {
    const { device_id, email } = req.body;
    const resultado = await crearLinkSuscripcion({ deviceId: device_id, email });
    return { ok: resultado.ok, data: resultado };
  });

  // Webhook de MercadoPago (POST /webhooks/mp)
  app.post('/webhooks/mp', async (req, reply) => {
    const resultado = await procesarWebhookMP(req.body);

    if (resultado.procesado && resultado.status === 'authorized') {
      await activarPremium({
        deviceId: resultado.deviceId,
        mpSubscriptionId: resultado.subId,
      });
      logger.info({ deviceId: resultado.deviceId }, '🎉 Premium activado via webhook MP');
    }

    if (resultado.procesado && resultado.status === 'cancelled') {
      const { pool } = await import('../db/pool.js');
      await pool.query(
        `UPDATE usuarios SET plan = 'free', actualizado_en = NOW()
         WHERE device_id = $1`,
        [resultado.deviceId]
      );
      logger.info({ deviceId: resultado.deviceId }, 'Premium cancelado via webhook MP');
    }

    return reply.code(200).send({ ok: true });
  });

  // Activar premium manualmente (dev/testing)
  app.post('/admin/premium/activate', {
    preHandler: async (req, reply) => {
      if (req.headers['x-api-key'] !== process.env.API_KEY)
        return reply.code(401).send({ error: 'unauthorized' });
    },
    schema: {
      body: z.object({
        device_id: z.string().min(8),
        meses: z.number().int().min(1).max(12).default(1),
      }),
    },
  }, async (req) => {
    const usuario = await activarPremium({
      deviceId: req.body.device_id,
      meses: req.body.meses,
    });
    return { ok: true, data: usuario };
  });
}
