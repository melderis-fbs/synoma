// POST /api/auth/verificar   body: { email, codigo }
//
// Paso 2 del login: se valida el código y se entrega la sesión (ver DIAS_SESION).

import { getSql, normalizarEmail, urlDeBase } from './_db.js';
import { verificarCodigo, crearSesion, cookieDeSesion, LIMITES } from './_auth.js';
import { configPublica } from './_config.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });
  if (!urlDeBase()) return json(503, { error: 'not_configured' });

  let cuerpo;
  try { cuerpo = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const email = normalizarEmail(cuerpo?.email);
  const codigo = String(cuerpo?.codigo ?? '');

  let resultado;
  try {
    resultado = await verificarCodigo(email, codigo);
  } catch (e) {
    console.error('[verificar] fallo consultando la base:', e?.message ?? e);
    return json(503, { error: 'db_error', message: 'No pudimos verificar el código. Probá de nuevo.' });
  }

  if (!resultado.ok) {
    // Mensajes distintos por motivo: "código incorrecto" y "código vencido"
    // requieren acciones distintas del cliente, y decirle solo "error" lo deja
    // reintentando lo mismo.
    const mensajes = {
      formato: 'El código son 6 números.',
      sin_codigo: 'No hay ningún código pendiente para ese email. Pedí uno nuevo.',
      usado: 'Ese código ya se usó. Pedí uno nuevo.',
      expirado: `El código venció (dura ${LIMITES.MINUTOS_CODIGO} minutos). Pedí uno nuevo.`,
      demasiados_intentos: 'Demasiados intentos con ese código. Pedí uno nuevo.',
      incorrecto: resultado.restantes > 0
        ? `Código incorrecto. Te quedan ${resultado.restantes} intento(s).`
        : 'Código incorrecto. Pedí uno nuevo.',
    };
    return json(401, {
      error: resultado.motivo,
      message: mensajes[resultado.motivo] ?? 'No pudimos validar el código.',
    });
  }

  // --- El código era válido. Se vuelve a chequear el acceso ----------------
  // Entre el pedido del código y su uso pueden pasar diez minutos, y en ese rato
  // se le pudo haber quitado el acceso.
  const sql = getSql();
  let cliente;
  try {
    const rows = await sql`
      SELECT id, email, nombre, acceso, origen_acceso
      FROM clientes WHERE lower(email) = ${email} LIMIT 1
    `;
    cliente = rows[0];
  } catch (e) {
    console.error('[verificar] fallo buscando el cliente:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }

  if (!cliente) return json(403, { error: 'sin_cliente', message: 'Pedí un código nuevo.' });

  if (cliente.acceso !== 'activo') {
    return json(403, {
      error: 'acceso_terminado',
      message: 'Tu acceso a Synoma terminó junto con el programa.',
      detalle: 'Podés seguir usándolo con una suscripción.',
      config: configPublica(),
    });
  }

  let token;
  try {
    token = await crearSesion(cliente.id, {
      userAgent: req.headers.get('user-agent'),
      // Netlify pasa la IP del cliente en esta cabecera. Se guarda para poder
      // detectar una cuenta usada desde muchos lugares distintos a la vez.
      ip: req.headers.get('x-nf-client-connection-ip')
        ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? null,
    });
  } catch (e) {
    console.error('[verificar] fallo creando la sesión:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }

  // ¿Ya cargó su identidad? El front lo usa para decidir si lo manda a la
  // pantalla de setup o directo al dashboard.
  let perfilCargado = false;
  try {
    const rows = await sql`
      SELECT length(oferta) > 0 AS listo FROM perfiles WHERE cliente_id = ${cliente.id}
    `;
    perfilCargado = rows[0]?.listo === true;
  } catch { /* si falla, va al setup: es el camino seguro */ }

  return new Response(JSON.stringify({
    ok: true,
    cliente: { email: cliente.email, nombre: cliente.nombre },
    perfil_cargado: perfilCargado,
    dias_sesion: LIMITES.DIAS_SESION,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookieDeSesion(token),
    },
  });
};

export const config = { path: '/api/auth/verificar' };

// ---------------------------------------------------------------------------

function mismoOrigen(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const extras = String(process.env.SYNOMA_ALLOWED_ORIGINS ?? '')
    .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  if (extras.includes(origin)) return true;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
