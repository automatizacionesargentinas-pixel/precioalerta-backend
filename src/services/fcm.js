import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

/**
 * Envía notificación push vía FCM Legacy API.
 * Para producción migrar a FCM HTTP v1 API con service account.
 */
export async function enviarNotificacion(deviceToken, { title, body, data = {} }) {
  const serverKey = process.env.FCM_SERVER_KEY;

  if (!serverKey || serverKey === 'tu_server_key_aqui') {
    logger.warn('FCM_SERVER_KEY no configurada — notificación simulada');
    logger.info({ deviceToken: deviceToken.slice(0, 20) + '...', title, body }, 'NOTIF simulada');
    return { simulated: true };
  }

  const payload = {
    to: deviceToken,
    priority: 'high',
    notification: {
      title,
      body,
      sound: 'default',
      badge: '1',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    data: {
      ...data,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
  };

  const res = await fetch(FCM_URL, {
    method:  'POST',
    headers: {
      'Authorization': `key=${serverKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();

  if (!res.ok || json.failure > 0) {
    logger.warn({ status: res.status, json }, 'FCM error');
    throw new Error(`FCM error: ${json.results?.[0]?.error ?? res.status}`);
  }

  logger.debug({ messageId: json.results?.[0]?.message_id }, 'FCM OK');
  return json;
}

/**
 * Envía a múltiples tokens (multicast).
 */
export async function enviarNotificacionMultiple(tokens, notification) {
  const resultados = await Promise.allSettled(
    tokens.map(token => enviarNotificacion(token, notification))
  );
  const ok    = resultados.filter(r => r.status === 'fulfilled').length;
  const error = resultados.filter(r => r.status === 'rejected').length;
  return { ok, error };
}
