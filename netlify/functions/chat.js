// Synoma Founders — el historial del cliente
//
//   GET    /api/chat  → { mensajes: [{ role, content, creado_en }, ...] }
//   DELETE /api/chat  → { ok: true, borradas: n }
//
// El cliente se identifica por su cookie de sesión. No se acepta un email ni un
// id por parámetro: si se aceptara, cambiar un valor en la petición dejaría leer
// la conversación de otra persona.
//
// El DELETE es del cliente sobre su propio historial. No existe —y no debe
// existir— ningún endpoint que devuelva mensajes de otro: el panel de admin ve
// cuántos mensajes hubo, nunca cuáles.

import { urlDeBase } from './_db.js';
import { clienteDeSesion } from './_auth.js';
import { historial, borrarChat, MENSAJES_PANTALLA } from './_conversacion.js';
import { configPublica } from './_config.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });
  if (!urlDeBase()) return json(503, { error: 'not_configured' });

  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    console.error('[chat] fallo leyendo la sesión:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }

  if (!cliente) {
    return json(401, { error: 'sin_sesion', message: 'Tu sesión venció. Volvé a entrar con tu email.' });
  }
  if (cliente.suspendido) {
    return json(403, {
      error: 'acceso_terminado',
      message: 'Tu acceso a Synoma terminó junto con el programa.',
      config: configPublica(),
    });
  }

  if (req.method === 'GET') {
    try {
      const mensajes = await historial(cliente.id, MENSAJES_PANTALLA);
      return json(200, { mensajes });
    } catch (e) {
      // Sin historial la app funciona igual: arranca la conversación en blanco.
      // Devolver 503 haría que el dashboard no abra por algo secundario.
      console.warn('[chat] fallo leyendo el historial:', e?.message ?? e);
      return json(200, { mensajes: [], parcial: true });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const borradas = await borrarChat(cliente.id);
      return json(200, { ok: true, borradas });
    } catch (e) {
      console.error('[chat] fallo borrando el historial:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos borrar tu historial. Probá de nuevo.' });
    }
  }

  return json(405, { error: 'method_not_allowed', message: 'Usá GET o DELETE.' });
};

export const config = { path: '/api/chat' };

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
