// Synoma Founders — la biblioteca de contenidos del cliente
//
//   GET    /api/biblioteca                  → { piezas: [...] }
//          ?estado=nueva&tipo=guion         → filtrado
//   POST   /api/biblioteca                  → guardar una pieza a mano
//          body: { contenido, titulo?, tipo? }
//   PATCH  /api/biblioteca                  → cambiar el estado
//          body: { id, estado }
//   DELETE /api/biblioteca?id=...           → borrar una pieza
//
// Todo filtra por la cookie de sesión. Nunca se acepta un cliente_id por
// parámetro: si se aceptara, cambiar un valor en la petición dejaría leer o
// borrar la biblioteca de otra persona.

import { urlDeBase } from './_db.js';
import { clienteDeSesion } from './_auth.js';
import {
  listarPiezas, guardarPieza, cambiarEstado, borrarPieza, ESTADOS, ETIQUETAS,
} from './_biblioteca.js';
import { configPublica } from './_config.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });
  if (!urlDeBase()) return json(503, { error: 'not_configured' });

  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    console.error('[biblioteca] fallo leyendo la sesión:', e?.message ?? e);
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

  const url = new URL(req.url);

  // --- Listar --------------------------------------------------------------
  if (req.method === 'GET') {
    const estado = filtro(url.searchParams.get('estado'), ESTADOS);
    const tipo = filtro(url.searchParams.get('tipo'), Object.keys(ETIQUETAS));
    try {
      const piezas = await listarPiezas(cliente.id, { estado, tipo });
      return json(200, { piezas, etiquetas: ETIQUETAS });
    } catch (e) {
      console.error('[biblioteca] fallo listando:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos abrir tu biblioteca. Probá de nuevo.' });
    }
  }

  // --- Guardar a mano ------------------------------------------------------
  // Para las respuestas que no vienen de un comando: el cliente le pide algo
  // escribiendo y le gusta cómo salió.
  if (req.method === 'POST') {
    let cuerpo;
    try { cuerpo = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

    if (!String(cuerpo?.contenido ?? '').trim()) {
      return json(400, { error: 'sin_contenido', message: 'No hay nada para guardar.' });
    }

    try {
      const pieza = await guardarPieza(cliente.id, {
        tipo: cuerpo.tipo ?? 'otro',
        titulo: cuerpo.titulo ?? '',
        contenido: cuerpo.contenido,
        comando: null,
      });
      return json(200, { ok: true, pieza });
    } catch (e) {
      console.error('[biblioteca] fallo guardando:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos guardarla. Probá de nuevo.' });
    }
  }

  // --- Cambiar el estado ---------------------------------------------------
  if (req.method === 'PATCH') {
    let cuerpo;
    try { cuerpo = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

    if (!esUuid(cuerpo?.id) || !ESTADOS.includes(cuerpo?.estado)) {
      return json(400, { error: 'parametros', message: 'Falta el id o el estado no es válido.' });
    }

    try {
      const pieza = await cambiarEstado(cliente.id, cuerpo.id, cuerpo.estado);
      // 404 y no 403: decir "existe pero no es tuya" ya es información.
      if (!pieza) return json(404, { error: 'no_encontrada' });
      return json(200, { ok: true, pieza });
    } catch (e) {
      console.error('[biblioteca] fallo cambiando el estado:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos actualizarla. Probá de nuevo.' });
    }
  }

  // --- Borrar --------------------------------------------------------------
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!esUuid(id)) return json(400, { error: 'parametros', message: 'Falta el id.' });
    try {
      const borrada = await borrarPieza(cliente.id, id);
      if (!borrada) return json(404, { error: 'no_encontrada' });
      return json(200, { ok: true });
    } catch (e) {
      console.error('[biblioteca] fallo borrando:', e?.message ?? e);
      return json(503, { error: 'db_error', message: 'No pudimos borrarla. Probá de nuevo.' });
    }
  }

  return json(405, { error: 'method_not_allowed', message: 'Usá GET, POST, PATCH o DELETE.' });
};

export const config = { path: '/api/biblioteca' };

// ---------------------------------------------------------------------------

// Se valida la forma del id antes de la consulta. Postgres rechaza un UUID mal
// formado con un error de sintaxis, que llegaría al cliente como "la base falló"
// cuando en realidad el pedido estaba mal armado.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (v) => UUID.test(String(v ?? '').trim());

// Un valor que no está en la lista blanca se trata como "sin filtro" en lugar de
// llegar a la consulta.
function filtro(valor, permitidos) {
  const v = String(valor ?? '').trim();
  return permitidos.includes(v) ? v : null;
}

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
