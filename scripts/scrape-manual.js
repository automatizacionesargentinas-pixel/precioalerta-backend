#!/usr/bin/env node
/**
 * PrecioAlerta AR — Scraping manual desde CLI
 *
 * Uso:
 *   node scripts/scrape-manual.js                    # todas las categorías
 *   node scripts/scrape-manual.js leche yogurt       # categorías específicas
 *   node scripts/scrape-manual.js --super=dia leche  # un solo super
 */

import 'dotenv/config';
import { testConnection } from '../src/db/pool.js';
import { scrapeVtex }    from '../src/services/scraperVtex.js';
import { scrapeCoto }    from '../src/services/scraperCoto.js';
import { guardarBatch }  from '../src/services/preciosDB.js';

const SUPERS_VTEX = [
  { id: 'dia',       base: 'https://diaonline.supermercadosdia.com.ar' },
  { id: 'carrefour', base: 'https://www.carrefour.com.ar' },
  { id: 'jumbo',     base: 'https://www.jumbo.com.ar' },
  { id: 'disco',     base: 'https://www.disco.com.ar' },
];

const args = process.argv.slice(2);
const superFlag = args.find(a => a.startsWith('--super='))?.split('=')[1];
const categorias = args.filter(a => !a.startsWith('--'));

const CATS_DEFAULT = ['leche', 'aceite', 'arroz', 'fideos', 'azucar', 'yerba', 'detergente'];
const cats = categorias.length ? categorias : CATS_DEFAULT;

async function main() {
  console.log('\n🛒 PrecioAlerta AR — Scraping manual');
  console.log(`   Categorías: ${cats.join(', ')}`);
  console.log(`   Super: ${superFlag ?? 'todos'}\n`);

  const ok = await testConnection();
  if (!ok) { console.error('❌ Sin conexión a PostgreSQL'); process.exit(1); }

  let totalProductos = 0, totalNuevos = 0;

  const supersToDo = superFlag
    ? (superFlag === 'coto' ? [] : SUPERS_VTEX.filter(s => s.id === superFlag))
    : SUPERS_VTEX;

  const incluirCoto = !superFlag || superFlag === 'coto';

  for (const s of supersToDo) {
    for (const cat of cats) {
      process.stdout.write(`  ${s.id.padEnd(10)} ${cat.padEnd(20)} `);
      const { productos, errores } = await scrapeVtex(s.base, s.id, cat, 2);
      if (productos.length) {
        const { guardados, preciosCambiados } = await guardarBatch(productos);
        totalProductos += guardados;
        totalNuevos    += preciosCambiados;
        console.log(`${productos.length} productos, ${preciosCambiados} precios nuevos ${errores ? `(${errores} errores)` : '✅'}`);
      } else {
        console.log(`sin resultados ${errores ? `(${errores} errores)` : ''}`);
      }
    }
  }

  if (incluirCoto) {
    for (const cat of cats) {
      process.stdout.write(`  coto       ${cat.padEnd(20)} `);
      const { productos, errores } = await scrapeCoto(cat, 2);
      if (productos.length) {
        const { guardados, preciosCambiados } = await guardarBatch(productos);
        totalProductos += guardados;
        totalNuevos    += preciosCambiados;
        console.log(`${productos.length} productos, ${preciosCambiados} precios nuevos ${errores ? `(${errores} errores)` : '✅'}`);
      } else {
        console.log(`sin resultados ${errores ? `(${errores} errores)` : ''}`);
      }
    }
  }

  console.log(`\n✅ Listo: ${totalProductos} productos procesados, ${totalNuevos} precios nuevos guardados\n`);
  process.exit(0);
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
