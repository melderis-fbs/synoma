// Synoma Founders — acceso a la base de datos
//
// Usa el driver HTTP de Neon (`@neondatabase/serverless`) y no un pool clásico.
// El motivo: cada invocación de una función serverless es un proceso distinto,
// así que un pool de conexiones abre una conexión nueva por invocación y Postgres
// tiene un límite. Con 100 clientes entrando un lunes a la mañana eso se agota.
// El driver HTTP no mantiene conexiones: cada consulta es un pedido y se termina.

import { neon } from '@neondatabase/serverless';

// Netlify nombra la variable distinto según cómo se creó la base (integración
// propia, extensión de Neon, o carga manual). En lugar de fijar un nombre y que
// falle en silencio, se buscan todos los que puede llegar a usar.
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
  // 1. Los nombres conocidos, en orden fijo: si hay más de uno, siempre gana el
  //    mismo y el comportamiento no cambia entre deploys.
  for (const variable of CANDIDATOS) {
    const url = process.env[variable];
    if (url && ES_URL_POSTGRES.test(url.trim())) return { url: url.trim(), variable };
  }

  // 2. Si ninguno está, se busca por CONTENIDO: cualquier variable cuyo valor
  //    sea una URL de Postgres. Adivinar nombres ya falló una vez; el valor no
  //    depende de cómo lo haya llamado la plataforma.
  for (const [variable, valor] of Object.entries(process.env)) {
    if (typeof valor === 'string' && ES_URL_POSTGRES.test(valor.trim())) {
      console.warn(`[db] URL encontrada en ${variable} (no estaba entre los nombres previstos)`);
      return { url: valor.trim(), variable };
    }
  }

  // 3. No hay nada. Se listan los NOMBRES de las variables que se le parecen
  //    —nunca los valores— para poder ver de un vistazo qué hay realmente.
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

// Costura para los tests: permite inyectar una base falsa y así probar la lógica
// de las funciones sin un Postgres corriendo. Solo la usan los tests.
export function usarSqlDePrueba(fn) {
  _sql = fn;
}

// Devuelve la función de consultas. Se cachea entre invocaciones que reusan el
// mismo contenedor.
export function getSql() {
  if (_sql) return _sql;
  const encontrada = urlDeBase();
  if (!encontrada) {
    throw new Error(
      `No hay URL de base de datos. Se buscó en: ${CANDIDATOS.join(', ')}. ` +
      'Creá la base en Netlify (Database) o cargá DATABASE_URL a mano.',
    );
  }
  _sql = neon(encontrada.url);
  return _sql;
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
