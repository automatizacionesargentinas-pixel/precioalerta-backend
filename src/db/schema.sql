-- PrecioAlerta AR — Schema PostgreSQL
-- Ejecutar con: node scripts/migrate.js

-- ─── Extensiones ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- full-text search con trigrams

-- ─── Supermercados ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supermercados (
  id          TEXT PRIMARY KEY,             -- 'dia', 'carrefour', 'coto', etc.
  nombre      TEXT NOT NULL,
  color_hex   TEXT,
  base_url    TEXT NOT NULL,
  tipo_api    TEXT NOT NULL DEFAULT 'vtex', -- 'vtex' | 'coto'
  activo      BOOLEAN DEFAULT TRUE,
  creado_en   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO supermercados (id, nombre, color_hex, base_url, tipo_api) VALUES
  ('dia',       'DIA',       '#E30613', 'https://diaonline.supermercadosdia.com.ar', 'vtex'),
  ('carrefour', 'Carrefour', '#004A97', 'https://www.carrefour.com.ar',             'vtex'),
  ('coto',      'Coto',      '#E30613', 'https://www.cotodigital.com.ar',           'coto'),
  ('jumbo',     'Jumbo',     '#00813A', 'https://www.jumbo.com.ar',                 'vtex'),
  ('disco',     'Disco',     '#C8102E', 'https://www.disco.com.ar',                 'vtex')
ON CONFLICT (id) DO NOTHING;

-- ─── Productos ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS productos (
  id            TEXT NOT NULL,
  super_id      TEXT NOT NULL REFERENCES supermercados(id),
  ean           TEXT,
  nombre        TEXT NOT NULL,
  marca         TEXT,
  categoria     TEXT,
  imagen_url    TEXT,
  url_producto  TEXT,
  creado_en     TIMESTAMPTZ DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, super_id)
);

CREATE INDEX IF NOT EXISTS idx_productos_ean    ON productos(ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_productos_super  ON productos(super_id);
CREATE INDEX IF NOT EXISTS idx_productos_trgm   ON productos USING GIN (nombre gin_trgm_ops);

-- ─── Historial de precios (append-only, series temporales) ────────────────────
CREATE TABLE IF NOT EXISTS precio_records (
  id            BIGSERIAL PRIMARY KEY,
  producto_id   TEXT NOT NULL,
  super_id      TEXT NOT NULL REFERENCES supermercados(id),
  precio        NUMERIC(12,2) NOT NULL,
  precio_lista  NUMERIC(12,2),
  descuento_pct SMALLINT DEFAULT 0,
  en_oferta     BOOLEAN DEFAULT FALSE,
  promo_texto   TEXT,
  registrado_en TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (producto_id, super_id) REFERENCES productos(id, super_id)
);

CREATE INDEX IF NOT EXISTS idx_precios_prod_super ON precio_records(producto_id, super_id);
CREATE INDEX IF NOT EXISTS idx_precios_fecha      ON precio_records(registrado_en DESC);
CREATE INDEX IF NOT EXISTS idx_precios_oferta     ON precio_records(en_oferta) WHERE en_oferta = TRUE;

-- Vista: precio actual por producto (el más reciente)
CREATE OR REPLACE VIEW precios_actuales AS
SELECT DISTINCT ON (producto_id, super_id)
  producto_id, super_id, precio, precio_lista,
  descuento_pct, en_oferta, promo_texto, registrado_en
FROM precio_records
ORDER BY producto_id, super_id, registrado_en DESC;

-- ─── Alertas de precio ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alertas (
  id              BIGSERIAL PRIMARY KEY,
  device_token    TEXT NOT NULL,              -- FCM token del dispositivo
  producto_id     TEXT NOT NULL,
  super_id        TEXT REFERENCES supermercados(id),
  precio_objetivo NUMERIC(12,2) NOT NULL,
  activa          BOOLEAN DEFAULT TRUE,
  creada_en       TIMESTAMPTZ DEFAULT NOW(),
  disparada_en    TIMESTAMPTZ,
  ultimo_precio   NUMERIC(12,2)
);

CREATE INDEX IF NOT EXISTS idx_alertas_activas ON alertas(activa) WHERE activa = TRUE;
CREATE INDEX IF NOT EXISTS idx_alertas_token   ON alertas(device_token);

-- ─── Tokens FCM de dispositivos ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_tokens (
  token       TEXT PRIMARY KEY,
  plataforma  TEXT,         -- 'android' | 'ios'
  creado_en   TIMESTAMPTZ DEFAULT NOW(),
  activo      BOOLEAN DEFAULT TRUE
);

-- ─── Log de scraping ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_logs (
  id              BIGSERIAL PRIMARY KEY,
  super_id        TEXT REFERENCES supermercados(id),
  query           TEXT,
  productos_total INTEGER DEFAULT 0,
  precios_nuevos  INTEGER DEFAULT 0,
  errores         INTEGER DEFAULT 0,
  duracion_ms     INTEGER,
  iniciado_en     TIMESTAMPTZ DEFAULT NOW(),
  finalizado_en   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_logs_super ON scrape_logs(super_id);
CREATE INDEX IF NOT EXISTS idx_logs_fecha ON scrape_logs(iniciado_en DESC);
