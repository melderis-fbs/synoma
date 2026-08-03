// GET    /api/auth/sesion  → quién soy, o 401
// DELETE /api/auth/sesion  → salir
//
// El front lo llama al abrir la página para decidir qué pantalla mostrar: login,
// carga de identidad, o dashboard.

import { urlDeBase, avisarSiFaltanTablas } from './_db.js';
import { clienteDeSesion, cerrarSesion, cookieBorrada } from './_auth.js';
import { leerPerfil } from './_perfil.js';
import { configPublica } from './_config.js';
import { blindar } from './_http.js';

export default blindar('sesion', async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });

  // Sin base de datos no hay sesión posible, pero esto no es un error del
  // cliente: se responde "no hay sesión" y el front muestra el login.
  if (!urlDeBase()) return json(200, { sesion: null, motivo: 'not_configured', config: configPublica() });

  if (req.method === 'DELETE') {
    try { await cerrarSesion(req); } catch (e) {
      console.warn('[sesion] fallo cerrando:', e?.message ?? e);
    }
    // La cookie se borra igual aunque falle la base: si no, el cliente queda
    // con una cookie que el servidor ya no reconoce y sin forma de salir.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Set-Cookie': cookieBorrada(),
      },
    });
  }

  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });

  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    // Si faltan las tablas, se responde "no hay sesión" en lugar de un error:
    // el cliente ve la pantalla de login normal, y el problema queda en el log
    // donde corresponde en vez de en su cara.
    if (avisarSiFaltanTablas(e, 'auth-sesion')) return json(200, { sesion: null, config: configPublica() });
    console.error('[sesion] fallo leyendo la sesión:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }

  if (!cliente) return json(200, { sesion: null, config: configPublica() });

  if (cliente.suspendido) {
    return json(200, {
      sesion: null,
      motivo: 'acceso_terminado',
      message: 'Tu acceso a Synoma terminó junto con el programa.',
      detalle: 'Podés seguir usándolo renovando tu acceso.',
      config: configPublica(),
    });
  }

  let perfilCargado = false;
  try {
    const perfil = await leerPerfil(cliente.id);
    perfilCargado = Boolean(perfil?.oferta);
  } catch {
    // Si falla, va al setup: es el camino seguro. Peor sería mandarlo al
    // dashboard y que el primer mensaje falle por falta de perfil.
  }

  return json(200, {
    config: configPublica(),
    sesion: {
      email: cliente.email,
      nombre: cliente.nombre,
      perfil_cargado: perfilCargado,
    },
  });
});

export const config = { path: '/api/auth/sesion' };

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
