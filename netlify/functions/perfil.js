// Synoma Founders — respaldo del perfil del cliente
//
// El perfil (Manual + Oferta + encuesta) vivía SOLO en el localStorage del
// navegador. Safari borra el localStorage escrito por JavaScript a los 7 días
// sin visitar el sitio, así que un cliente de iPhone que usa Synoma cada dos
// semanas tenía que volver a pegar tres documentos largos cada vez.
//
// Esta función guarda una copia en Netlify Blobs, indexada por código. El
// localStorage sigue siendo la copia rápida local; esto es la red de seguridad.
//
//   GET  /api/perfil?code=FND-ANA1   → { profile } | 404 si no hay respaldo
//   PUT  /api/perfil                 → { ok: true }   body: { code, profile }
//
// Nota de privacidad: el perfil ya salía del navegador en cada mensaje (va
// dentro del prompt hacia la API de Claude). Guardarlo en tu propia cuenta de
// Netlify no agrega una exposición nueva, pero sí te vuelve responsable de esos
// datos: son documentos de negocio de tus clientes. Si preferís no guardarlos,
// borrá esta función y el bloque `respaldo` de public/index.html.

import { getStore } from '@netlify/blobs';

const LIMITS = { manual: 30000, oferta: 15000, encuesta: 10000 };

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  if (!originAllowed(req)) {
    return json(403, { error: 'forbidden_origin', message: 'Origen no permitido.' });
  }

  const validCodes = parseCodes(process.env.SYNOMA_CODES);
  if (validCodes.length === 0) {
    return json(503, { error: 'not_configured', message: 'Servidor sin configurar.' });
  }

  let store;
  try {
    store = getStore('synoma-perfiles');
  } catch (e) {
    console.warn('[perfil] Blobs no disponible:', e?.message ?? e);
    return json(503, { error: 'storage_unavailable', message: 'Respaldo no disponible.' });
  }

  // --- Leer el respaldo ----------------------------------------------------
  if (req.method === 'GET') {
    const code = normalize(new URL(req.url).searchParams.get('code'));
    if (!validCodes.includes(code)) {
      return json(403, { error: 'invalid_code', message: 'Código inválido o vencido.' });
    }
    try {
      const stored = await store.get(code, { type: 'json' });
      if (!stored) return json(404, { error: 'no_backup', message: 'Sin respaldo guardado.' });
      return json(200, { profile: stored });
    } catch (e) {
      console.error('[perfil] fallo leyendo respaldo:', e?.message ?? e);
      return json(502, { error: 'read_failed', message: 'No se pudo leer el respaldo.' });
    }
  }

  // --- Guardar el respaldo -------------------------------------------------
  if (req.method === 'PUT') {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: 'bad_json', message: 'Cuerpo no es JSON válido.' });
    }

    const code = normalize(payload?.code);
    if (!validCodes.includes(code)) {
      return json(403, { error: 'invalid_code', message: 'Código inválido o vencido.' });
    }

    const p = payload?.profile ?? {};
    const profile = {
      manual: clip(p.manual, LIMITS.manual),
      oferta: clip(p.oferta, LIMITS.oferta),
      encuesta: clip(p.encuesta, LIMITS.encuesta),
      updated_at: new Date().toISOString(),
    };

    // Se rechaza un perfil vacío: si no, un cliente que abre la pantalla de
    // identidad y guarda sin pegar nada le pisa el respaldo bueno con vacío.
    if (!profile.oferta) {
      return json(400, {
        error: 'empty_profile',
        message: 'Como mínimo hace falta la Oferta en Una Página.',
      });
    }

    try {
      await store.setJSON(code, profile);
      return json(200, { ok: true, updated_at: profile.updated_at });
    } catch (e) {
      console.error('[perfil] fallo guardando respaldo:', e?.message ?? e);
      return json(502, { error: 'write_failed', message: 'No se pudo guardar el respaldo.' });
    }
  }

  return json(405, { error: 'method_not_allowed', message: 'Usá GET o PUT.' });
};

export const config = { path: '/api/perfil' };

// ---------------------------------------------------------------------------

const normalize = (v) => String(v ?? '').trim().toUpperCase();
const clip = (v, max) => String(v ?? '').trim().slice(0, max);

function parseCodes(raw) {
  return String(raw ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
}

function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = String(process.env.SYNOMA_ALLOWED_ORIGINS ?? '')
    .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
