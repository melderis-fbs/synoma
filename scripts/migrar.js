// Aplica las migraciones de db/*.sql
//
// Corre como build command en cada deploy (ver netlify.toml), así que las tablas
// se crean solas y nunca hay que abrir una terminal ni pegar SQL a mano.
//
// Dos reglas de comportamiento deliberadas:
//
//   · Sin URL de base de datos → avisa y NO falla. Si no fuera así, cualquier
//     deploy hecho antes de crear la base rompería el sitio entero.
//
//   · Con URL pero migración fallida → FALLA el deploy. Publicar código que
//     espera tablas que no existen es peor que no publicar: el error aparecería
//     después, en la cara de un cliente, en lugar de acá.
//
// Cada archivo se aplica dentro de una transacción y se anota en la tabla
// `migraciones`. Correr esto dos veces no hace nada la segunda vez.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR_MIGRACIONES = join(RAIZ, 'db');

// Mismos candidatos que netlify/functions/_db.js. Están duplicados a propósito:
// este script corre en el build y no debería importar código de las funciones.
const CANDIDATOS = [
  'NETLIFY_DATABASE_URL',
  'NETLIFY_DATABASE_URL_UNPOOLED',
  'DATABASE_URL',
  'POSTGRES_URL',
  'NEON_DATABASE_URL',
];

const ES_URL_POSTGRES = /^postgres(ql)?:\/\/\S+$/i;

function urlDeBase() {
  for (const variable of CANDIDATOS) {
    const url = process.env[variable];
    if (url && ES_URL_POSTGRES.test(url.trim())) return { url: url.trim(), variable };
  }

  // Igual que en las funciones: si el nombre no es ninguno de los previstos, se
  // busca por contenido. El valor no depende de cómo lo llame la plataforma.
  for (const [variable, valor] of Object.entries(process.env)) {
    if (typeof valor === 'string' && ES_URL_POSTGRES.test(valor.trim())) {
      console.warn(`[migrar] URL encontrada en ${variable} (nombre no previsto)`);
      return { url: valor.trim(), variable };
    }
  }
  return null;
}

async function main() {
  const encontrada = urlDeBase();

  if (!encontrada) {
    console.warn('[migrar] ── No hay base de datos configurada; se omiten las migraciones.');
    console.warn(`[migrar]    Se buscó en: ${CANDIDATOS.join(', ')}`);
    const parecidas = Object.keys(process.env)
      .filter((k) => /DATABASE|POSTGRES|NEON|^PG/i.test(k)).sort();
    console.warn(`[migrar]    Variables presentes que se le parecen: ${parecidas.join(', ') || '(ninguna)'}`);
    console.warn('[migrar]    El sitio se publica igual, pero el login no va a funcionar');
    console.warn('[migrar]    hasta que exista la base. Netlify → Database.');
    return;
  }

  console.log(`[migrar] usando la variable ${encontrada.variable}`);

  const archivos = (await readdir(DIR_MIGRACIONES))
    .filter((f) => f.endsWith('.sql'))
    .sort();   // el prefijo numérico (001_, 002_) define el orden

  if (archivos.length === 0) {
    console.log('[migrar] no hay archivos .sql en db/');
    return;
  }

  const cliente = new pg.Client({
    connectionString: encontrada.url,
    // La base duerme tras 5 minutos de inactividad, así que la primera conexión
    // puede tardar unos segundos en despertarla.
    connectionTimeoutMillis: 30_000,
  });

  await cliente.connect();

  try {
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migraciones (
        nombre      TEXT PRIMARY KEY,
        aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const { rows } = await cliente.query('SELECT nombre FROM migraciones');
    const aplicadas = new Set(rows.map((r) => r.nombre));

    let nuevas = 0;
    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) {
        console.log(`[migrar]   · ${archivo} — ya aplicada`);
        continue;
      }

      const sql = await readFile(join(DIR_MIGRACIONES, archivo), 'utf8');
      console.log(`[migrar]   → ${archivo} — aplicando…`);

      // Transacción por archivo: si una migración falla a mitad de camino, la
      // base queda como estaba en lugar de a medio migrar.
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO migraciones (nombre) VALUES ($1)', [archivo]);
        await cliente.query('COMMIT');
        nuevas += 1;
      } catch (e) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw new Error(`${archivo}: ${e.message}`);
      }
    }

    console.log(nuevas > 0
      ? `[migrar] ✓ ${nuevas} migración(es) aplicada(s).`
      : '[migrar] ✓ la base ya estaba al día.');
  } finally {
    await cliente.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('');
  console.error('[migrar] ✗ FALLÓ LA MIGRACIÓN — el deploy se detiene a propósito.');
  console.error(`[migrar]   ${e.message}`);
  console.error('');
  console.error('[migrar]   Publicar código que espera tablas que no existen haría');
  console.error('[migrar]   que el error apareciera después, en la cara de un cliente.');
  process.exit(1);
});
