/**
 * MercadoPago Suscripciones — Ahorramás Premium
 * ================================================
 * Plan: $X ARS/mes (configurar en MP Dashboard)
 */
import { logger } from '../utils/logger.js';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_PLAN_ID      = process.env.MP_PLAN_ID;       // ID del plan en MP
const APP_URL         = process.env.APP_URL || 'https://ahorramas.com.ar';

// Crear link de suscripción para el usuario
export async function crearLinkSuscripcion({ deviceId, email }) {
  if (!MP_ACCESS_TOKEN || !MP_PLAN_ID) {
    return { ok: false, error: 'MP no configurado', url: null };
  }

  try {
    const body = {
      preapproval_plan_id: MP_PLAN_ID,
      payer_email:         email || undefined,
      back_url:            `${APP_URL}/premium?device_id=${deviceId}&status=success`,
      external_reference:  deviceId,
    };

    const res = await fetch('https://api.mercadopago.com/preapproval', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Error MP');

    logger.info({ deviceId, preapprovalId: data.id }, 'Link suscripción creado');
    return { ok: true, url: data.init_point, preapprovalId: data.id };
  } catch (err) {
    logger.error({ err, deviceId }, 'Error creando suscripción MP');
    return { ok: false, error: err.message, url: null };
  }
}

// Verificar estado de una suscripción
export async function verificarSuscripcion(preapprovalId) {
  if (!MP_ACCESS_TOKEN) return null;
  try {
    const res = await fetch(`https://api.mercadopago.com/preapproval/${preapprovalId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });
    return await res.json();
  } catch {
    return null;
  }
}

// Webhook de MP — procesar notificaciones de pago
export async function procesarWebhookMP(body) {
  const { type, data } = body;
  if (type !== 'subscription_preapproval') return { procesado: false };

  const sub = await verificarSuscripcion(data?.id);
  if (!sub) return { procesado: false };

  return {
    procesado: true,
    status:    sub.status,          // 'authorized' | 'paused' | 'cancelled'
    deviceId:  sub.external_reference,
    subId:     sub.id,
    payerId:   sub.payer_id,
  };
}
