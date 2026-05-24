import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';

const COTO_API   = 'https://api.coto.com.ar/api/v1/ms-digital-sitio-bff-web/api/v1';
const COTO_KEY   = 'key_r6xzz4IAoTWcipni';
const COTO_STORE = '200';
const DELAY      = parseInt(process.env.SCRAPE_DELAY_MS   ?? '1500');
const TIMEOUT    = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? '10000');
const MAX_PAG    = parseInt(process.env.SCRAPE_MAX_PAGES  ?? '5');
const PAGE_SZ    = 24;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCoto(raw) {
  try {
    const p  = raw.data;
    const pd = Array.isArray(p.price)
      ? (p.price.find(x => x.store === COTO_STORE) ?? p.price[0])
      : {};
    const precio = parseFloat(pd.formatPrice ?? pd.listPrice ?? 0);
    if (!precio || precio <= 0) return null;

    const precioLista = parseFloat(p.product_list_price ?? precio);
    const desc = p.discounts?.[0];

    return {
      id:           p.id,
      superId:      'coto',
      ean:          p.product_main_ean ? String(p.product_main_ean) : null,
      nombre:       (p.sku_display_name ?? p.sku_description ?? '').trim(),
      marca:        p.product_brand ?? null,
      categoria:    raw.labels?.[0] ?? null,
      imagenUrl:    p.product_large_image_url ?? p.image_url ?? null,
      urlProducto:  `https://www.cotodigital.com.ar/sitios/cdigi/producto${p.url ?? ''}`,
      precio,
      precioLista,
      descuentoPct: precioLista > precio ? Math.round((1 - precio / precioLista) * 100) : 0,
      enOferta:     precioLista > precio || (p.sale_type?.length > 0),
      promoTexto:   desc?.discountText ?? p.sale_type?.[0] ?? null,
    };
  } catch {
    return null;
  }
}

export async function scrapeCoto(query, maxPaginas = MAX_PAG) {
  const productos = [];
  let errores = 0;

  for (let pag = 1; pag <= maxPaginas; pag++) {
    const params = new URLSearchParams({
      key:                  COTO_KEY,
      num_results_per_page: PAGE_SZ,
      page:                 pag,
      pre_filter_expression: JSON.stringify({ name: 'store_availability', value: COTO_STORE }),
    });
    const url = `${COTO_API}/products/search/${encodeURIComponent(query)}?${params}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);

      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'PrecioAlertaAR/1.0' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        logger.warn({ query, pag, status: res.status }, 'Coto HTTP error');
        errores++;
        break;
      }

      const json = await res.json();
      const lista = json.response?.results ?? [];
      if (!lista.length) break;

      lista.forEach(raw => {
        const p = parseCoto(raw);
        if (p) productos.push(p);
      });

      logger.debug({ query, pag, recibidos: lista.length, acumulados: productos.length }, 'Coto page OK');

      if (lista.length < PAGE_SZ) break;
      await sleep(DELAY);

    } catch (err) {
      logger.warn({ query, pag, err: err.message }, 'Coto fetch error');
      errores++;
      break;
    }
  }

  return { productos, errores };
}
