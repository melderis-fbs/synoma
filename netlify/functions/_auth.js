// Synoma Founders — sesiones y códigos de acceso
//
// Reemplaza los códigos compartidos por email + código de 6 dígitos.
//
// Por qué el cambio: un código compartido no identifica a nadie. Si Ana se lo
// pasa a una amiga, las dos entran y no hay forma de distinguirlas ni de medir
// consumo por persona. Y con 100 clientes, mantener la lista a mano en una
// variable de entorno es una fábrica de errores.
//
// Dos reglas que se respetan en todo el archivo:
//
//   · Nada se guarda en claro. Ni los códigos ni los tokens de sesión: solo su
//     hash. Una filtración de la base no permite entrar como nadie.
//
//   · Las comparaciones de secretos son en tiempo constante. Comparar con ===
//     tarda distinto según cuántos caracteres coinciden, y eso alcanza para
//     adivinar un secreto midiendo tiempos.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getSql, normalizarEmail } from './_db.js';

export const COOKIE = 'synoma_sesion';

// 120 días. La sesión larga es deliberada: el login es fricción, y este es un
// producto que se usa a rachas —una semana intensa, dos sin entrar—. Con 60 días
// un cliente que vuelve después de un mes y medio se encuentra con que tiene que
// pedir un código otra vez, justo cuando volvía.
const DIAS_SESION = 120;
const MINUTOS_CODIGO = 10;
const MAX_INTENTOS = 5;

// Tope de códigos pedidos por email por hora. Sin esto, alguien puede usar el
// formulario para llenarle la casilla a un cliente.
const MAX_PEDIDOS_HORA = 5;

// ---------------------------------------------------------------------------
// Utilidades de hash
// ---------------------------------------------------------------------------

const hash = (valor) => createHash('sha256').update(String(valor)).digest('hex');

// Comparación en tiempo constante, tolerante a largos distintos.
function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Códigos de acceso
// ---------------------------------------------------------------------------

// randomInt del módulo crypto, no Math.random: Math.random es predecible y con
// seis dígitos eso significa que el código se puede adivinar.
export function generarCodigo() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export async function pedidosRecientes(email) {
  const sql = getSql();
  const rows = await sql`
    SELECT count(*)::int AS n
    FROM codigos_acceso
    WHERE lower(email) = ${normalizarEmail(email)}
      AND creado_en > now() - INTERVAL '1 hour'
  `;
  return rows[0]?.n ?? 0;
}

export function superoPedidos(n) {
  return n >= MAX_PEDIDOS_HORA;
}

export async function guardarCodigo(email, codigo) {
  const sql = getSql();
  const correo = normalizarEmail(email);

  // Los códigos anteriores del mismo email se invalidan: si no, quedan varios
  // vivos a la vez y cada uno es una oportunidad más de adivinar.
  await sql`
    UPDATE codigos_acceso
    SET usado_en = now()
    WHERE lower(email) = ${correo} AND usado_en IS NULL
  `;

  await sql`
    INSERT INTO codigos_acceso (email, codigo_hash, expira_en)
    VALUES (${correo}, ${hash(codigo)},
            now() + (${MINUTOS_CODIGO} || ' minutes')::interval)
  `;
}

// Devuelve { ok } o { ok: false, motivo } con motivos distinguibles, para poder
// darle al cliente un mensaje útil en lugar de un "error" genérico.
export async function verificarCodigo(email, codigo) {
  const sql = getSql();
  const correo = normalizarEmail(email);
  const limpio = String(codigo ?? '').replace(/\D/g, '');

  if (limpio.length !== 6) return { ok: false, motivo: 'formato' };

  const rows = await sql`
    SELECT id, codigo_hash, intentos, expira_en, usado_en
    FROM codigos_acceso
    WHERE lower(email) = ${correo}
    ORDER BY creado_en DESC
    LIMIT 1
  `;

  const fila = rows[0];
  if (!fila) return { ok: false, motivo: 'sin_codigo' };
  if (fila.usado_en) return { ok: false, motivo: 'usado' };
  if (new Date(fila.expira_en) < new Date()) return { ok: false, motivo: 'expirado' };
  if (fila.intentos >= MAX_INTENTOS) return { ok: false, motivo: 'demasiados_intentos' };

  if (!igualSeguro(fila.codigo_hash, hash(limpio))) {
    await sql`UPDATE codigos_acceso SET intentos = intentos + 1 WHERE id = ${fila.id}`;
    const restantes = MAX_INTENTOS - (fila.intentos + 1);
    return { ok: false, motivo: 'incorrecto', restantes: Math.max(restantes, 0) };
  }

  await sql`UPDATE codigos_acceso SET usado_en = now() WHERE id = ${fila.id}`;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

export async function crearSesion(clienteId, { userAgent = null, ip = null } = {}) {
  const sql = getSql();
  const token = randomBytes(32).toString('base64url');

  await sql`
    INSERT INTO sesiones (cliente_id, token_hash, expira_en, user_agent, ip)
    VALUES (${clienteId}, ${hash(token)},
            now() + (${DIAS_SESION} || ' days')::interval,
            ${userAgent}, ${ip})
  `;

  return token;
}

// Devuelve el cliente de la sesión, o null. Comprueba de paso que siga teniendo
// acceso: si se le quitó el tag en GHL, la sesión deja de servir sin necesidad
// de esperar a que expire.
export async function clienteDeSesion(req) {
  const token = leerCookie(req, COOKIE);
  if (!token) return null;

  const sql = getSql();
  const rows = await sql`
    SELECT c.id, c.email, c.nombre, c.acceso, c.origen_acceso, s.id AS sesion_id
    FROM sesiones s
    JOIN clientes c ON c.id = s.cliente_id
    WHERE s.token_hash = ${hash(token)}
      AND s.expira_en > now()
    LIMIT 1
  `;

  const fila = rows[0];
  if (!fila) return null;
  if (fila.acceso !== 'activo') return { ...fila, suspendido: true };

  // Sin await: actualizar la marca de uso no debe demorar la respuesta.
  sql`
    UPDATE sesiones SET ultimo_uso_en = now() WHERE id = ${fila.sesion_id}
  `.catch(() => {});
  sql`
    UPDATE clientes SET ultimo_acceso_en = now() WHERE id = ${fila.id}
  `.catch(() => {});

  return fila;
}

export async function cerrarSesion(req) {
  const token = leerCookie(req, COOKIE);
  if (!token) return;
  const sql = getSql();
  await sql`DELETE FROM sesiones WHERE token_hash = ${hash(token)}`;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function cookieDeSesion(token) {
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${DIAS_SESION * 24 * 60 * 60}`,
    'HttpOnly',            // el JavaScript de la página no la puede leer
    'Secure',              // solo por HTTPS
    // Lax y no Strict a propósito: con Strict la cookie no viaja cuando el
    // cliente llega desde un enlace externo, y ese es justo el flujo previsto
    // (entrar a Synoma desde el portal de GHL o desde Skool).
    'SameSite=Lax',
  ].join('; ');
}

export function cookieBorrada() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function leerCookie(req, nombre) {
  const cabecera = req.headers.get('cookie');
  if (!cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    if (parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Alta y actualización del cliente
// ---------------------------------------------------------------------------

// Crea el cliente si no existe y le fija el acceso según lo que dijo GHL.
// El índice único es sobre lower(email), así que ON CONFLICT va sobre eso.
export async function upsertCliente({ email, nombre, ghlContactId, acceso, origen }) {
  const sql = getSql();
  const correo = normalizarEmail(email);

  const rows = await sql`
    INSERT INTO clientes (email, nombre, ghl_contact_id, acceso, origen_acceso, ghl_verificado_en)
    VALUES (${correo}, ${nombre ?? null}, ${ghlContactId ?? null},
            ${acceso}, ${origen}, now())
    ON CONFLICT (lower(email)) DO UPDATE SET
      nombre            = COALESCE(EXCLUDED.nombre, clientes.nombre),
      ghl_contact_id    = COALESCE(EXCLUDED.ghl_contact_id, clientes.ghl_contact_id),
      acceso            = EXCLUDED.acceso,
      -- origen_acceso NO se sobreescribe si ya era 'suscripcion': alguien que
      -- paga por su cuenta no debe volver a contarse como miembro de Founders
      -- solo porque el tag siga en GHL.
      origen_acceso     = CASE WHEN clientes.origen_acceso = 'suscripcion'
                               THEN clientes.origen_acceso ELSE EXCLUDED.origen_acceso END,
      ghl_verificado_en = now(),
      actualizado_en    = now()
    RETURNING id, email, nombre, acceso, origen_acceso
  `;

  return rows[0];
}

export const LIMITES = { DIAS_SESION, MINUTOS_CODIGO, MAX_INTENTOS, MAX_PEDIDOS_HORA };
