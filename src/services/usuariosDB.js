import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

export const PLAN_LIMITES = {
  free:    { alertas: 3 },
  premium: { alertas: Infinity },
};

// Obtener o crear usuario por device_id
export async function getOrCreateUsuario(deviceId) {
  const { rows } = await pool.query(
    `INSERT INTO usuarios (device_id)
     VALUES ($1)
     ON CONFLICT (device_id) DO UPDATE SET actualizado_en = NOW()
     RETURNING *`,
    [deviceId]
  );
  return rows[0];
}

// Contar alertas activas del usuario
export async function contarAlertasActivas(deviceId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as total FROM alertas
     WHERE device_id = $1 AND activa = true`,
    [deviceId]
  );
  return parseInt(rows[0].total);
}

// Crear alerta con control freemium
export async function crearAlertaFreemium({ deviceId, productoId, superId, precioObjetivo }) {
  const usuario = await getOrCreateUsuario(deviceId);
  const limite = PLAN_LIMITES[usuario.plan].alertas;
  const actuales = await contarAlertasActivas(deviceId);

  if (actuales >= limite) {
    return {
      ok: false,
      error: 'limite_alcanzado',
      plan: usuario.plan,
      limite,
      actuales,
      mensaje: usuario.plan === 'free'
        ? `Alcanzaste el límite de ${limite} alertas gratuitas. Actualizá a Premium para alertas ilimitadas.`
        : `Límite de alertas alcanzado.`,
    };
  }

  const { rows } = await pool.query(
    `INSERT INTO alertas (device_id, usuario_id, producto_id, super_id, precio_objetivo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [deviceId, usuario.id, productoId, superId || null, precioObjetivo]
  );

  return { ok: true, alerta: rows[0], plan: usuario.plan, actuales: actuales + 1, limite };
}

// Obtener alertas del usuario
export async function getAlertasUsuario(deviceId) {
  const { rows } = await pool.query(
    `SELECT a.*, p.nombre as producto_nombre, p.imagen_url,
            s.nombre as super_nombre, s.color_hex as super_color
     FROM alertas a
     LEFT JOIN productos p ON p.id = a.producto_id AND p.super_id = COALESCE(a.super_id, p.super_id)
     LEFT JOIN supermercados s ON s.id = a.super_id
     WHERE a.device_id = $1 AND a.activa = true
     ORDER BY a.creada_en DESC`,
    [deviceId]
  );
  return rows;
}

// Eliminar alerta
export async function eliminarAlerta(alertaId, deviceId) {
  const { rowCount } = await pool.query(
    `UPDATE alertas SET activa = false
     WHERE id = $1 AND device_id = $2`,
    [alertaId, deviceId]
  );
  return rowCount > 0;
}

// Actualizar plan a premium tras pago aprobado
export async function activarPremium({ deviceId, mpPaymentId, mpSubscriptionId, meses = 1 }) {
  const premiumHasta = new Date();
  premiumHasta.setMonth(premiumHasta.getMonth() + meses);

  const { rows } = await pool.query(
    `UPDATE usuarios
     SET plan = 'premium',
         mp_subscription_id = $2,
         premium_desde = NOW(),
         premium_hasta = $3,
         actualizado_en = NOW()
     WHERE device_id = $1
     RETURNING *`,
    [deviceId, mpSubscriptionId || null, premiumHasta]
  );

  if (rows[0] && mpPaymentId) {
    await pool.query(
      `INSERT INTO pagos (usuario_id, mp_payment_id, mp_status, concepto, periodo_fin)
       VALUES ($1, $2, 'approved', 'premium_mensual', $3)
       ON CONFLICT (mp_payment_id) DO NOTHING`,
      [rows[0].id, mpPaymentId, premiumHasta]
    );
  }

  return rows[0];
}

// Verificar y degradar usuarios con premium vencido
export async function verificarVencimientos() {
  const { rowCount } = await pool.query(
    `UPDATE usuarios SET plan = 'free', actualizado_en = NOW()
     WHERE plan = 'premium' AND premium_hasta < NOW()`
  );
  if (rowCount > 0) logger.info({ degradados: rowCount }, 'Planes premium vencidos degradados');
  return rowCount;
}

// Estado del usuario (para el frontend)
export async function getEstadoUsuario(deviceId) {
  const usuario = await getOrCreateUsuario(deviceId);
  const actuales = await contarAlertasActivas(deviceId);
  const limite = PLAN_LIMITES[usuario.plan].alertas;

  return {
    plan: usuario.plan,
    esPremium: usuario.plan === 'premium',
    premiumHasta: usuario.premium_hasta,
    alertas: { actuales, limite: limite === Infinity ? null : limite },
  };
}
