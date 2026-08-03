// Synoma Founders — el plan semanal como calendario y como archivo
//
//   GET /api/plan?id=<pieza>              → { plan: { piezas: [...] } }
//   GET /api/plan?id=<pieza>&formato=ics  → descarga .ics (Google Calendar, iPhone)
//   GET /api/plan?id=<pieza>&formato=csv  → descarga .csv (Excel, Sheets)
//
// La pieza tiene que ser del cliente de la sesión. El id se valida antes de la
// consulta porque Postgres rechaza un UUID mal formado con un error de sintaxis,
// que llegaría al cliente como "la base falló".

import { urlDeBase } from './_db.js';
import { clienteDeSesion } from './_auth.js';
import { leerPieza } from './_biblioteca.js';
import { parsearPlan, fecharPiezas, generarIcs, generarCsv } from './_plan.js';
import { configPublica } from './_config.js';
import { blindar } from './_http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default blindar('plan', async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });
  if (!urlDeBase()) return json(503, { error: 'not_configured' });

  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    console.error('[plan] fallo leyendo la sesión:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }

  if (!cliente) {
    return json(401, { error: 'sin_sesion', message: 'Tu sesión venció. Volvé a entrar con tu email.' });
  }
  if (cliente.suspendido) {
    return json(403, { error: 'acceso_terminado', config: configPublica() });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!UUID.test(String(id ?? '').trim())) {
    return json(400, { error: 'parametros', message: 'Falta el id del plan.' });
  }

  let pieza;
  try {
    pieza = await leerPieza(cliente.id, id);
  } catch (e) {
    console.error('[plan] fallo leyendo la pieza:', e?.message ?? e);
    return json(503, { error: 'db_error' });
  }
  if (!pieza) return json(404, { error: 'no_encontrada' });

  const plan = parsearPlan(pieza.contenido);
  if (!plan) {
    // Pasa si el modelo se salió del formato de la tabla. No es un error del
    // cliente ni de la base: la app se queda mostrando el texto plano, que sigue
    // siendo un plan perfectamente usable.
    console.warn(`[plan] no se pudo armar el calendario de la pieza ${pieza.id} (tipo ${pieza.tipo})`);
    return json(422, {
      error: 'sin_tabla',
      message: 'Este plan no tiene el formato de tabla, así que no puedo armarte el calendario. Pedile un /semana nuevo y va a salir bien.',
    });
  }

  // Las fechas se calculan desde el día en que se generó el plan, no desde hoy:
  // si el cliente abre en septiembre un plan de agosto, tiene que ver las fechas
  // de agosto y no un calendario corrido tres semanas.
  const piezas = fecharPiezas(plan.piezas, new Date(pieza.creado_en));
  const formato = String(url.searchParams.get('formato') ?? 'json').toLowerCase();
  const base = nombreArchivo(piezas[0]?.fecha);

  if (formato === 'ics') {
    return archivo(generarIcs(piezas, { nombre: pieza.titulo || 'Mi semana de contenido' }),
      'text/calendar; charset=utf-8', `${base}.ics`);
  }

  if (formato === 'csv') {
    return archivo(generarCsv(piezas), 'text/csv; charset=utf-8', `${base}.csv`);
  }

  return json(200, {
    plan: {
      id: pieza.id,
      titulo: pieza.titulo,
      creado_en: pieza.creado_en,
      piezas,
    },
  });
});

export const config = { path: '/api/plan' };

// ---------------------------------------------------------------------------

function nombreArchivo(fecha) {
  return `synoma-semana-${fecha ?? 'plan'}`;
}

function archivo(cuerpo, tipo, nombre) {
  return new Response(cuerpo, {
    status: 200,
    headers: {
      'Content-Type': tipo,
      // attachment y no inline: con inline, Safari en iPhone abre el .ics como
      // texto en una pestaña en vez de ofrecer agregarlo al calendario.
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
    },
  });
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
