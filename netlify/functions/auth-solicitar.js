// POST /api/auth/solicitar   body: { email }
//
// Paso 1 del login: se valida contra GHL y se manda el código por email.
//
// Variables de entorno relacionadas:
//   RENOVACION_URL   dónde mandar a quien terminó el programa (link de pago,
//                    WhatsApp, formulario). Si está vacío se muestra el mensaje
//                    sin enlace.

import { normalizarEmail, emailPlausible, urlDeBase, avisarSiFaltanTablas } from './_db.js';
import { buscarContacto, ghlConfigurado } from './_ghl.js';
import { enviarCodigo } from './_email.js';
import {
  generarCodigo, guardarCodigo, pedidosRecientes, superoPedidos, upsertCliente, LIMITES,
} from './_auth.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!mismoOrigen(req)) return json(403, { error: 'forbidden_origin' });

  if (!urlDeBase()) {
    console.error('[solicitar] no hay base de datos configurada');
    return json(503, {
      error: 'not_configured',
      message: 'El acceso todavía no está configurado. Avisale a tu coach.',
    });
  }

  let cuerpo;
  try { cuerpo = await req.json(); } catch { return json(400, { error: 'bad_json' }); }

  const email = normalizarEmail(cuerpo?.email);
  if (!emailPlausible(email)) {
    return json(400, { error: 'email_invalido', message: 'Revisá el email: no parece válido.' });
  }

  // --- Tope de pedidos por hora --------------------------------------------
  // Sin esto, el formulario sirve para llenarle la casilla a un cliente.
  try {
    if (superoPedidos(await pedidosRecientes(email))) {
      return json(429, {
        error: 'demasiados_pedidos',
        message: `Pediste el código ${LIMITES.MAX_PEDIDOS_HORA} veces en la última hora. Esperá un rato o avisale a tu coach.`,
      });
    }
  } catch (e) {
    if (avisarSiFaltanTablas(e, 'auth-solicitar')) {
      return json(503, {
        error: 'sin_tablas',
        message: 'El acceso está a medio configurar. Avisale a tu coach.',
      });
    }
    console.error('[solicitar] fallo consultando la base:', e?.message ?? e);
    return json(503, { error: 'db_error', message: 'No podemos verificar tu acceso en este momento.' });
  }

  // --- ¿Tiene acceso? ------------------------------------------------------
  const consulta = ghlConfigurado()
    ? await buscarContacto(email)
    : await sinGhl(email);

  if (consulta.estado === 'error') {
    // No se deja entrar a nadie si no se puede verificar: preferimos un cliente
    // esperando cinco minutos a alguien accediendo sin permiso.
    console.error('[solicitar] no se pudo verificar en GHL:', consulta.motivo);
    return json(503, {
      error: 'verificacion_no_disponible',
      message: 'No podemos verificar tu acceso en este momento. Probá en unos minutos.',
    });
  }

  // Terminó el programa y no renovó. Es el caso que pidió Vicky que quede
  // señalizado: no es un error, es una oferta.
  if (consulta.estado === 'sin_tag') {
    await marcarSuspendido(email, consulta.contacto);
    return json(403, {
      error: 'acceso_terminado',
      message: 'Tu acceso a Synoma terminó junto con el programa.',
      detalle: 'Podés seguir usándolo renovando tu acceso.',
      renovacion_url: process.env.RENOVACION_URL || null,
    });
  }

  if (consulta.estado === 'no_existe') {
    return json(404, {
      error: 'email_no_encontrado',
      message: 'No encontramos ese email entre los clientes de Founders.',
      detalle: 'Revisá si lo escribiste bien o si usaste otra dirección al anotarte.',
    });
  }

  // --- Alta o actualización + envío ----------------------------------------
  let cliente;
  try {
    cliente = await upsertCliente({
      email,
      nombre: consulta.contacto?.nombre,
      ghlContactId: consulta.contacto?.id,
      acceso: 'activo',
      origen: 'founders',
    });
  } catch (e) {
    console.error('[solicitar] fallo dando de alta al cliente:', e?.message ?? e);
    return json(503, { error: 'db_error', message: 'No pudimos preparar tu acceso. Probá de nuevo.' });
  }

  const codigo = generarCodigo();
  try {
    await guardarCodigo(email, codigo);
  } catch (e) {
    console.error('[solicitar] fallo guardando el código:', e?.message ?? e);
    return json(503, { error: 'db_error', message: 'No pudimos generar tu código. Probá de nuevo.' });
  }

  const envio = await enviarCodigo(email, codigo);
  if (!envio.ok) {
    return json(502, {
      error: 'envio_falló',
      message: 'No pudimos enviarte el email. Probá de nuevo en un minuto.',
    });
  }

  return json(200, {
    ok: true,
    nombre: cliente?.nombre ?? null,
    minutos: LIMITES.MINUTOS_CODIGO,

    // El código se devuelve al navegador SOLO cuando no hay RESEND_API_KEY, o
    // sea cuando es imposible que llegue un email. En cuanto se configure el
    // envío, esta rama deja de ejecutarse y el código nunca más sale del
    // servidor: el agujero se cierra solo, no depende de acordarse de sacarlo.
    modo_desarrollo: envio.modo === 'log' || undefined,
    codigo_desarrollo: envio.modo === 'log' ? codigo : undefined,
  });
};

export const config = { path: '/api/auth/solicitar' };

// ---------------------------------------------------------------------------

// Mientras GHL no esté configurado, se acepta solo a los emails de
// SYNOMA_EMAILS_PRUEBA. Permite probar todo el login antes de tocar GHL, sin
// abrirle la puerta a cualquiera.
async function sinGhl(email) {
  const permitidos = String(process.env.SYNOMA_EMAILS_PRUEBA ?? '')
    .split(',').map(normalizarEmail).filter(Boolean);

  if (permitidos.length === 0) {
    console.error('[solicitar] GHL sin configurar y SYNOMA_EMAILS_PRUEBA vacío');
    return { estado: 'error', motivo: 'sin_fuente_de_verdad' };
  }

  console.warn(`[solicitar] MODO PRUEBA: validando contra SYNOMA_EMAILS_PRUEBA, no contra GHL`);
  return permitidos.includes(email)
    ? { estado: 'activo', contacto: { id: null, email, nombre: null, tags: [] } }
    : { estado: 'no_existe' };
}

async function marcarSuspendido(email, contacto) {
  try {
    await upsertCliente({
      email,
      nombre: contacto?.nombre,
      ghlContactId: contacto?.id,
      acceso: 'suspendido',
      origen: 'founders',
    });
  } catch (e) {
    console.error('[solicitar] fallo marcando suspendido:', e?.message ?? e);
  }
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
