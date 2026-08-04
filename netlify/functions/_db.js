// Synoma Founders — acceso a la base de datos
//
// Usa el driver `pg` con un pool de conexiones. En el entorno serverless original
// usábamos el driver HTTP de Neon para no agotar conexiones; acá corremos en un
// proceso long-lived (Vite dev server), así que un pool es la opción correcta.

import pg from 'pg';

const { Pool } = pg;

// Se busca la URL de Postgres en varias variables, igual que antes.
const CANDIDATOS = [
  'NETLIFY_DATABASE_URL',
  'NETLIFY_DATABASE_URL_UNPOOLED',
  'DATABASE_URL',
  'POSTGRES_URL',
  'NEON_DATABASE_URL',
];

const ES_URL_POSTGRES = /^postgres(ql)?:\/\/\S+$/i;

let yaAvisado = false;

export function urlDeBase() {
  for (const variable of CANDIDATOS) {
    const url = process.env[variable];
    if (url && ES_URL_POSTGRES.test(url.trim())) return { url: url.trim(), variable };
  }

  for (const [variable, valor] of Object.entries(process.env)) {
    if (typeof valor === 'string' && ES_URL_POSTGRES.test(valor.trim())) {
      console.warn(`[db] URL encontrada en ${variable} (no estaba entre los nombres previstos)`);
      return { url: valor.trim(), variable };
    }
  }

  if (!yaAvisado) {
    yaAvisado = true;
    const parecidas = Object.keys(process.env)
      .filter((k) => /DATABASE|POSTGRES|NEON|^PG/i.test(k))
      .sort();
    console.error('[db] no se encontró ninguna URL de Postgres en el entorno.');
    console.error(`[db]   nombres buscados: ${CANDIDATOS.join(', ')}`);
    console.error(`[db]   variables presentes que se le parecen: ${parecidas.join(', ') || '(ninguna)'}`);
  }

  return null;
}

let _sql = null;
let _pool = null;

// Costura para los tests: permite inyectar una base falsa y así probar la lógica
// de las funciones sin un Postgres corriendo. Solo la usan los tests.
export function usarSqlDePrueba(fn) {
  _sql = fn;
}

// Devuelve una función tagged-template que imita la API de `neon()`.
// Uso: const sql = getSql(); const rows = await sql`SELECT * FROM ...`;
export function getSql() {
  if (_sql) return _sql;
  const encontrada = urlDeBase();
  if (!encontrada) {
    throw new Error(
      `No hay URL de base de datos. Se buscó en: ${CANDIDATOS.join(', ')}. ` +
      'Cargá DATABASE_URL en el entorno.',
    );
  }

  if (!_pool) {
    _pool = new Pool({
      connectionString: encontrada.url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  // Wrapper que imita la API tagged-template de neon()
  const sql = (strings, ...values) => {
    // Reconstruye la consulta con $1, $2, ... como haría neon()
    let text = '';
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `${i + 1}`;
    }
    return _pool.query(text, values).then(r => r.rows);
  };

  // Exponer el pool para cierre limpio si hace falta
  sql._pool = _pool;
  _sql = sql;
  return _sql;
}

// Postgres 42P01 = la tabla no existe.
//
// Se distingue a propósito de cualquier otro fallo de base: significa que la
// conexión anda pero las migraciones no corrieron, y el arreglo es completamente
// distinto (correr las migraciones, no revisar credenciales ni red). Sin esta
// distinción el síntoma es idéntico al de una base caída.
export function faltanTablas(e) {
  return e?.code === '42P01' || /relation .* does not exist/i.test(e?.message ?? '');
}

export function avisarSiFaltanTablas(e, origen) {
  if (!faltanTablas(e)) return false;
  console.error('');
  console.error(`[db] ✗ ${origen}: la base responde pero NO tiene las tablas.`);
  console.error('[db]   Las migraciones corren en el build, y el build no ve la base.');
  console.error('[db]   Arreglo: copiar el connection string de Netlify → Database y');
  console.error('[db]   cargarlo como DATABASE_URL en Environment variables, después redeploy.');
  console.error('');
  return true;
}

// Para chequeos de salud y para que el panel de admin pueda distinguir
// "no hay datos" de "la base no responde".
export async function baseDisponible() {
  try {
    const sql = getSql();
    await sql`SELECT 1`;
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: e?.message ?? String(e) };
  }
}

// ---------------------------------------------------------------------------
// Normalización del email
// ---------------------------------------------------------------------------

// El email es la identidad, así que tiene que normalizarse igual en todos lados
// o el mismo cliente termina con dos filas y el perfil partido en dos.
//
// Deliberadamente NO se tocan los puntos ni el signo +: en Gmail son
// equivalentes, pero en muchos otros proveedores no, y descartarlos haría que
// dos personas distintas cayeran en la misma cuenta.
export function normalizarEmail(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
        .replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '')   // espacios, incluidos los invisibles
    .toLowerCase();
}

// Validación deliberadamente laxa: alcanza para descartar basura evidente sin
// rechazar direcciones válidas raras. La validación de verdad es que el código
// llegue al buzón.
export function emailPlausible(email) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email);
}
