import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

const DELAY   = parseInt(process.env.SCRAPE_DELAY_MS  ?? '1500');
const TIMEOUT = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? '10000');
const MAX_PAG = parseInt(process.env.SCRAPE_MAX_PAGES  ?? '5');
const PAGE_SZ = 50;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PrecioAlertaAR/1.0; +https://precioalerta.ar)',
  'Accept':     'application/json',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Parser de producto VTEX ──────────────────────────────────────────────────

function parseVtex(raw, superId) {
  try {
    const item  = raw.items[0];
    const offer = item.sellers[0].commertialOffer;
    const precio = parseFloat(offer.Price);
    if (!precio || precio <= 0) return null;

    const precioLista = parseFloat(offer.ListPrice ?? offer.Price);
    return {
      id:           String(raw.productId),
      superId,
      ean:          item.ean ?? null,
      nombre:       raw.productName?.trim() ?? '',
      marca:        raw.brand?.trim() ?? null,
      categoria:    (raw.categories?.[0] ?? '').split('/').filter(Boolean).join(' > ') || null,
      imagenUrl:    item.images?.[0]?.imageUrl ?? null,
      urlProducto:  raw.link ?? null,
      precio,
      precioLista,
      descuentoPct: precioLista > precio ? Math.round((1 - precio / precioLista) * 100) : 0,
      enOferta:     precioLista > precio,
      promoTexto:   null,
    };
  } catch {
    return null;
  }
}

// ─── Scraper VTEX ────────────────────────────────────────────────────────────

export async function scrapeVtex(baseUrl, superId, query, maxPaginas = MAX_PAG) {
  const productos = [];
  let errores = 0;

  for (let pag = 0; pag < maxPaginas; pag++) {
    const desde = pag * PAGE_SZ;
    const hasta = desde + PAGE_SZ - 1;
    const url = `${baseUrl}/api/catalog_system/pub/products/search/${encodeURIComponent(query)}?_from=${desde}&_to=${hasta}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);

      const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        logger.warn({ superId, query, status: res.status, pag }, 'VTEX HTTP error');
        errores++;
        break;
      }

      const lista = await res.json();
      if (!Array.isArray(lista) || lista.length === 0) break;

      lista.forEach(raw => {
        const p = parseVtex(raw, superId);
        if (p) productos.push(p);
      });

      logger.debug({ superId, query, pag, recibidos: lista.length, acumulados: productos.length }, 'VTEX page OK');

      if (lista.length < PAGE_SZ) break;
      await sleep(DELAY);

    } catch (err) {
      logger.warn({ superId, query, pag, err: err.message }, 'VTEX fetch error');
      errores++;
      break;
    }
  }

  return { productos, errores };
}
