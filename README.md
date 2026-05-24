# PrecioAlerta AR — Backend

API REST + scraping automático de precios de supermercados argentinos.

## Stack
- **Runtime:** Node.js 22 + ES Modules
- **HTTP:** Fastify 4
- **DB:** PostgreSQL 16 (series temporales de precios)
- **Caché:** Redis 7
- **Cron:** node-cron
- **Push:** Firebase Cloud Messaging
- **Deploy:** Railway / Docker

---

## Inicio rápido (local con Docker)

```bash
# 1. Clonar y configurar
cp .env.example .env
# Editar .env con tus valores (mínimo: FCM_SERVER_KEY)

# 2. Levantar todo
docker-compose up -d

# 3. Verificar
curl http://localhost:3000/health
# → {"status":"ok","version":"1.0.0"}

# 4. Ver logs
docker-compose logs -f backend
```

El servidor corre en `http://localhost:3000`.
La migración del schema corre automáticamente al iniciar.

---

## Deploy en Railway (recomendado para producción)

### Paso 1 — Crear proyecto

1. Ir a [railway.app](https://railway.app) y crear cuenta
2. **New Project → Deploy from GitHub repo**
3. Seleccionar este repositorio

### Paso 2 — Agregar servicios

En el dashboard del proyecto:

1. **+ New → Database → PostgreSQL** → Railway provee `DATABASE_URL` automáticamente
2. **+ New → Database → Redis** → Railway provee `REDIS_URL` automáticamente

### Paso 3 — Variables de entorno

En el servicio del backend, ir a **Variables** y agregar:

```
NODE_ENV=production
API_KEY=<clave-segura-aleatoria>
FCM_SERVER_KEY=<tu-server-key-de-firebase>
LOG_LEVEL=info
```

`DATABASE_URL` y `REDIS_URL` se agregan automáticamente al linkear los plugins.

### Paso 4 — Deploy

Railway hace el deploy automáticamente al pushear a `main`.
El schema de la DB se migra en el primer arranque.

### Paso 5 — Dominio

En **Settings → Networking → Generate Domain** para obtener una URL pública como:
`https://precioalerta-backend.up.railway.app`

---

## Endpoints de la API

### Búsqueda

```
GET /v1/products/search?q=leche&limit=20
```

Devuelve productos agrupados por supermercado con precio actual.

```json
{
  "ok": true,
  "data": [
    {
      "superId": "dia",
      "superNombre": "DIA",
      "superColor": "#E30613",
      "productos": [
        {
          "id": "123456",
          "nombre": "Leche Entera DIA 1L",
          "precio": 1600,
          "precioLista": 2050,
          "descuentoPct": 22,
          "enOferta": true
        }
      ]
    }
  ]
}
```

### Por EAN

```
GET /v1/products/ean/7792298001040
```

### Historial de precios

```
GET /v1/products/{id}/prices?super_id=dia&dias=90
```

### Ofertas

```
GET /v1/offers?super_id=carrefour&limit=50
GET /v1/offers                                  # todos los supers
```

### Alertas

```
POST /v1/alerts
Content-Type: application/json

{
  "device_token": "FCM_TOKEN_DEL_DISPOSITIVO",
  "producto_id": "123456",
  "super_id": "dia",
  "precio_objetivo": 1400
}
```

### Admin (requiere X-Api-Key header)

```
POST /admin/scrape          # dispara scraping manual
POST /admin/check-alerts    # verifica y dispara alertas
GET  /stats                 # métricas de la DB
```

---

## Scraping manual desde CLI

```bash
# Scrapear categorías por defecto en todos los supers
npm run scrape

# Scrapear categorías específicas
node scripts/scrape-manual.js leche aceite arroz

# Solo un supermercado
node scripts/scrape-manual.js --super=dia leche
node scripts/scrape-manual.js --super=coto almacen
```

---

## Cron jobs automáticos

| Job | Schedule | Descripción |
|-----|----------|-------------|
| Scraping completo | `0 */6 * * *` | Todas las categorías, cada 6h |
| Scraping ofertas | `0 */2 * * *` | Categorías prioritarias, cada 2h |
| Verificar alertas | `*/30 * * * *` | Chequea y dispara alertas, cada 30min |

Configurable vía `.env`:
```
CRON_PRECIOS=0 */6 * * *
CRON_OFERTAS=0 */2 * * *
CRON_ALERTAS=*/30 * * * *
```

---

## Configurar Firebase (FCM)

1. Ir a [console.firebase.google.com](https://console.firebase.google.com)
2. Crear proyecto (o usar uno existente)
3. **Project Settings → Cloud Messaging → Server key**
4. Copiar la Server Key en `FCM_SERVER_KEY` del `.env`

---

## Estructura del proyecto

```
src/
  server.js          # Fastify + plugins + arranque
  routes/
    api.js           # Todos los endpoints REST
  services/
    scraperVtex.js   # Scraper DIA / Carrefour / Jumbo / Disco
    scraperCoto.js   # Scraper Coto (API propia)
    preciosDB.js     # Operaciones PostgreSQL
    fcm.js           # Firebase Cloud Messaging
  workers/
    scrapeWorker.js  # Cron jobs + worker de alertas
  db/
    pool.js          # Conexión PostgreSQL
    redis.js         # Conexión Redis + caché helpers
    schema.sql       # Schema de la base de datos
  utils/
    logger.js        # Pino logger
scripts/
  migrate.js         # Ejecutar schema.sql
  scrape-manual.js   # Scraping desde CLI
```
