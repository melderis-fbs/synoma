// Synoma Founders — la identidad de marca del cliente
//
//   GET  /api/perfil  → { perfil } | { perfil: null } si todavía no cargó nada
//   PUT  /api/perfil  → { ok: true }   body: { manual, oferta, encuesta }
//
// El cliente se identifica por su cookie de sesión. Nunca se acepta un id ni un
// email por parámetro: si no, cualquiera podría leer o escribir el perfil de
// otro cambiando un valor en la petición.
//
// Antes esto vivía solo en el localStorage del navegador. Safari borra el
// localStorage escrito por JavaScript a los 7 días sin visitar el sitio, así que
// un cliente de iPhone que usaba Synoma cada dos semanas tenía que volver a
// pegar tres documentos largos cada vez.

import { urlDeBase } from './_db.js';
import { clienteDeSesion } from './_auth.js';
import { leerPerfil, guardarPerfil, LIMITES_PERFIL } from './_perfil.js';
import { configPublica } from './_config.js';
import { blindar } from './_http.js';

export default blindar('perfil', async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });
  if (!urlDeBase()) return json(503, { error: 'not_configured' });

  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    console.error('[perfil] fallo leyendo la sesión:', e?.message ?? e);
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

  // --- Leer ----------------------------------------------------------------
  if (req.method === 'GET') {
    try {
      const perfil = await leerPerfil(cliente.id);
      return json(200, { perfil: perfil ?? null, limites: LIMITES_PERFIL });
    } catch (e) {
      console.error('[perfil] fallo leyendo:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos leer tu identidad.' });
    }
  }

  // --- Guardar -------------------------------------------------------------
  if (req.method === 'PUT') {
    let cuerpo;
    try { cuerpo = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

    try {
      const r = await guardarPerfil(cliente.id, cuerpo);
      if (!r.ok) {
        return json(400, {
          error: r.motivo,
          message: 'Como mínimo hace falta tu Oferta en Una Página: sin eso Synoma escribe genérico.',
        });
      }
      return json(200, { ok: true, actualizado_en: r.actualizado_en });
    } catch (e) {
      console.error('[perfil] fallo guardando:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos guardar tu identidad. Probá de nuevo.' });
    }
  }

  return json(405, { error: 'method_not_allowed', message: 'Usá GET o PUT.' });
});

export const config = { path: '/api/perfil' };

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
