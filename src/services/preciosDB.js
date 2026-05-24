import { query, withTransaction } from '../db/pool.js';
import { logger } from '../utils/logger.js';

// ─── Upsert producto ──────────────────────────────────────────────────────────

export async function upsertProducto(client, p) {
  await client.query(`
    INSERT INTO productos (id, super_id, ean, nombre, marca, categoria, imagen_url, url_producto, actualizado_en)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    ON CONFLICT (id, super_id) DO UPDATE SET
      nombre        = EXCLUDED.nombre,
      marca         = EXCLUDED.marca,
      categoria     = EXCLUDED.categoria,
      imagen_url    = COALESCE(EXCLUDED.imagen_url, productos.imagen_url),
      url_producto  = COALESCE(EXCLUDED.url_producto, productos.url_producto),
      actualizado_en = NOW()
  `, [p.id, p.superId, p.ean, p.nombre, p.marca, p.categoria, p.imagenUrl, p.urlProducto]);
}

// ─── Guardar precio (solo si cambió) ─────────────────────────────────────────

export async function guardarPrecioSiCambio(client, p) {
  const ultimo = await client.query(`
    SELECT precio FROM precio_records
    WHERE producto_id=$1 AND super_id=$2
    ORDER BY registrado_en DESC
    LIMIT 1
  `, [p.id, p.superId]);

  const precioAnterior = ultimo.rows[0]?.precio;
  if (precioAnterior !== undefined && Math.abs(parseFloat(precioAnterior) - p.precio) < 0.01) {
    return false;
  }

  await client.query(`
    INSERT INTO precio_records (producto_id, super_id, precio, precio_lista, descuento_pct, en_oferta, promo_texto)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [p.id, p.superId, p.precio, p.precioLista, p.descuentoPct, p.enOferta, p.promoTexto]);

  return true;
}

// ─── Guardar batch de productos ───────────────────────────────────────────────

export async function guardarBatch(productos) {
  if (!productos.length) return { guardados: 0, preciosCambiados: 0 };

  let guardados = 0;
  let preciosCambiados = 0;

  await withTransaction(async (client) => {
    for (const p of productos) {
      await upsertProducto(client, p);
      const cambio = await guardarPrecioSiCambio(client, p);
      guardados++;
      if (cambio) preciosCambiados++;
    }
  });

  return { guardados, preciosCambiados };
}

// ─── Búsquedas ────────────────────────────────────────────────────────────────

export async function buscarProductos(q, limite = 20) {
  const res = await query(`
    SELECT
      p.id, p.super_id, p.ean, p.nombre, p.marca, p.categoria, p.imagen_url, p.url_producto,
      pa.precio, pa.precio_lista, pa.descuento_pct, pa.en_oferta, pa.promo_texto, pa.registrado_en,
      s.nombre AS super_nombre, s.color_hex AS super_color
    FROM productos p
    JOIN supermercados s ON s.id = p.super_id
    LEFT JOIN precios_actuales pa ON pa.producto_id = p.id AND pa.super_id = p.super_id
    WHERE p.nombre ILIKE $1
    ORDER BY pa.precio ASC NULLS LAST
    LIMIT $2
  `, [`%${q}%`, limite]);
  return res.rows;
}

export async function buscarPorEAN(ean) {
  const res = await query(`
    SELECT
      p.id, p.super_id, p.ean, p.nombre, p.marca, p.imagen_url,
      pa.precio, pa.precio_lista, pa.descuento_pct, pa.en_oferta, pa.registrado_en,
      s.nombre AS super_nombre, s.color_hex AS super_color
    FROM productos p
    JOIN supermercados s ON s.id = p.super_id
    LEFT JOIN precios_actuales pa ON pa.producto_id = p.id AND pa.super_id = p.super_id
    WHERE p.ean = $1
    ORDER BY pa.precio ASC NULLS LAST
  `, [ean]);
  return res.rows;
}

export async function getHistorialPrecios(productoId, superId, dias = 90) {
  const res = await query(`
    SELECT precio, precio_lista, descuento_pct, en_oferta, promo_texto, registrado_en
    FROM precio_records
    WHERE producto_id=$1 AND super_id=$2
      AND registrado_en >= NOW() - INTERVAL '${parseInt(dias)} days'
    ORDER BY registrado_en ASC
  `, [productoId, superId]);
  return res.rows;
}

export async function getEstadisticasPrecios(productoId, superId) {
  const res = await query(`
    SELECT
      MIN(precio)::NUMERIC(12,2)  AS precio_min,
      MAX(precio)::NUMERIC(12,2)  AS precio_max,
      AVG(precio)::NUMERIC(12,2)  AS precio_avg,
      COUNT(*)::INT                AS total_registros,
      MIN(registrado_en)           AS primer_registro,
      MAX(registrado_en)           AS ultimo_registro
    FROM precio_records
    WHERE producto_id=$1 AND super_id=$2
  `, [productoId, superId]);
  return res.rows[0];
}

export async function getOfertas(superId = null, limite = 50) {
  const cond = superId ? 'AND p.super_id = $2' : '';
  const params = superId ? [limite, superId] : [limite];
  const paramIdx = superId ? '$2' : '';

  const res = await query(`
    SELECT
      p.id, p.super_id, p.nombre, p.marca, p.imagen_url, p.url_producto,
      pa.precio, pa.precio_lista, pa.descuento_pct, pa.promo_texto, pa.registrado_en,
      s.nombre AS super_nombre, s.color_hex AS super_color
    FROM productos p
    JOIN supermercados s ON s.id = p.super_id
    JOIN precios_actuales pa ON pa.producto_id = p.id AND pa.super_id = p.super_id
    WHERE pa.en_oferta = TRUE ${cond}
    ORDER BY pa.descuento_pct DESC, pa.registrado_en DESC
    LIMIT $1
  `, params);
  return res.rows;
}

// ─── Alertas ──────────────────────────────────────────────────────────────────

export async function getAlertasDisparadas() {
  const res = await query(`
    SELECT
      a.id, a.device_token, a.producto_id, a.super_id, a.precio_objetivo,
      p.nombre, p.marca, p.imagen_url,
      pa.precio AS precio_actual, pa.super_id AS super_precio,
      s.nombre AS super_nombre
    FROM alertas a
    JOIN productos p ON p.id = a.producto_id
    JOIN precios_actuales pa ON pa.producto_id = a.producto_id
      AND (pa.super_id = a.super_id OR a.super_id IS NULL)
    JOIN supermercados s ON s.id = pa.super_id
    WHERE a.activa = TRUE
      AND pa.precio <= a.precio_objetivo
      AND a.disparada_en IS NULL
    ORDER BY a.creada_en ASC
  `);
  return res.rows;
}

export async function marcarAlertaDisparada(id, precioActual) {
  await query(`
    UPDATE alertas SET disparada_en = NOW(), ultimo_precio = $2 WHERE id = $1
  `, [id, precioActual]);
}

export async function crearAlerta({ deviceToken, productoId, superId, precioObjetivo }) {
  const res = await query(`
    INSERT INTO alertas (device_token, producto_id, super_id, precio_objetivo)
    VALUES ($1,$2,$3,$4) RETURNING id
  `, [deviceToken, productoId, superId ?? null, precioObjetivo]);
  return res.rows[0].id;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getStats() {
  const res = await query(`
    SELECT
      (SELECT COUNT(*) FROM productos)::INT           AS total_productos,
      (SELECT COUNT(*) FROM precio_records)::INT      AS total_precios,
      (SELECT COUNT(*) FROM alertas WHERE activa)::INT AS alertas_activas,
      (SELECT COUNT(*) FROM supermercados WHERE activo)::INT AS supers_activos,
      (SELECT MAX(registrado_en) FROM precio_records) AS ultimo_scrape
  `);
  return res.rows[0];
}
