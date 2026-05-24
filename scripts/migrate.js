#!/usr/bin/env node
/**
 * PrecioAlerta AR — Migración de base de datos
 * Uso: node scripts/migrate.js
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Client } = pg;

async function migrate() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('🔌 Conectando a PostgreSQL...');
    await client.connect();
    console.log('✅ Conectado');

    const schema = readFileSync(join(__dirname, '../src/db/schema.sql'), 'utf8');

    console.log('📦 Ejecutando migraciones...');
    await client.query(schema);
    console.log('✅ Schema aplicado correctamente');

    // Verificar tablas creadas
    const res = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    console.log('\n📋 Tablas en la base de datos:');
    res.rows.forEach(r => console.log('  -', r.tablename));

  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
