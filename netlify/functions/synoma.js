// Synoma Founders — motor de contenido
//
// Función serverless (Netlify Functions 2.0): valida el código del cliente,
// arma el prompt con su perfil y hace streaming de la respuesta de Claude.
//
// El prompt del sistema vive en ./_prompt.js — editalo ahí, no acá.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY       (requerida)  sk-ant-...
//   SYNOMA_CODES            (requerida)  FND-ANA1,FND-LUZ2,FND-PAB3
//   SYNOMA_DAILY_LIMIT      (opcional)   mensajes por código por día. Default 60.
//   SYNOMA_ALLOWED_ORIGINS  (opcional)   solo si la app se sirve desde OTRO dominio.
//                                        Vacío = únicamente mismo origen (lo normal).

import { getStore } from '@netlify/blobs';
import { SYSTEM_BASE } from './_prompt.js';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2500;
const HISTORY_TURNS = 12;
const DEFAULT_DAILY_LIMIT = 60;

// Topes de tamaño del perfil, iguales a la v1.
const LIMITS = { manual: 30000, oferta: 15000, encuesta: 10000, message: 20000 };

export default async (req) => {
  const cors = corsFor(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Usá POST.', cors);

  // --- Chequeo de origen (del lado del servidor) ---------------------------
  // CORS solo evita que un sitio ajeno LEA la respuesta; la llamada igual se
  // ejecuta y consume tokens. Este chequeo la rechaza antes de gastar plata.
  if (!originAllowed(req)) {
    return fail(403, 'forbidden_origin', 'Origen no permitido.', cors);
  }

  // --- Config del servidor -------------------------------------------------
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const validCodes = parseCodes(process.env.SYNOMA_CODES);

  // 503 = "el motor no está configurado". Es la ÚNICA condición que habilita
  // el modo demo en el front. Cualquier otro error se muestra como error.
  if (!apiKey || validCodes.length === 0) {
    return fail(503, 'not_configured',
      'El motor todavía no está configurado en el servidor.', cors);
  }

  // --- Payload -------------------------------------------------------------
  let payload;
  try {
    payload = await req.json();
  } catch {
    return fail(400, 'bad_json', 'El cuerpo de la petición no es JSON válido.', cors);
  }

  const code = String(payload?.code ?? '').trim().toUpperCase();
  const profile = payload?.profile ?? {};
  const messages = payload?.messages;

  if (!code || !validCodes.includes(code)) {
    // Diagnóstico sin volcar códigos completos al log. Comparar los largos
    // distingue "lo escribió mal" de "llegó cortado" o "la variable no tiene
    // lo que creemos que tiene".
    console.warn('[synoma] código rechazado:', JSON.stringify({
      recibido: code ? `${code.slice(0, 4)}…(${code.length} car.)` : '(vacío)',
      codigos_cargados: validCodes.length,
      largos_cargados: validCodes.map((c) => c.length),
    }));
    return fail(403, 'invalid_code',
      'Código inválido o vencido. Consultá a tu coach.', cors);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return fail(400, 'no_messages', 'No llegó ningún mensaje.', cors);
  }

  // --- Tope de uso por código y por día ------------------------------------
  const limit = Number(process.env.SYNOMA_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  const usage = await bumpUsage(code, limit);
  if (usage.exceeded) {
    return fail(429, 'daily_limit',
      `Llegaste al tope de ${limit} mensajes por hoy. Mañana se renueva.`, cors);
  }

  // --- System prompt en dos bloques cacheables -----------------------------
  // Bloque 1: SYSTEM_BASE — idéntico para todos los clientes, se cachea global.
  // Bloque 2: el perfil    — estable por cliente, se cachea por cliente.
  // Las lecturas de caché cuestan el 10% del precio normal de entrada.
  const system = [
    { type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: profileBlock(profile), cache_control: { type: 'ephemeral' } },
  ];

  const trimmed = messages.slice(-HISTORY_TURNS).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? '').slice(0, LIMITS.message),
  }));

  // --- Llamada a Claude, con streaming y reintentos ------------------------
  let upstream;
  try {
    upstream = await callClaude({ apiKey, system, messages: trimmed });
  } catch (e) {
    console.error('[synoma] fallo llamando a Anthropic:', e?.message ?? e);
    return fail(502, 'upstream_error',
      'El motor no responde en este momento. Probá de nuevo en un minuto.', cors);
  }

  // A partir de acá el stream ya arrancó: los errores se emiten DENTRO del
  // stream, porque los headers HTTP ya salieron.
  return new Response(toNdjson(upstream.body, code), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // que ningún proxy intermedio bufferee
    },
  });
};

export const config = { path: '/api/synoma' };

// ---------------------------------------------------------------------------
// Llamada a la API con reintentos
// ---------------------------------------------------------------------------

// Reintenta 429 / 529 / 5xx, que son transitorios. El SDK oficial de Anthropic
// hace esto solo; con fetch crudo hay que escribirlo (y sin él, un pico de
// carga en la API se le muestra al cliente como "el motor está ocupado").
async function callClaude({ apiKey, system, messages, attempt = 0 }) {
  const MAX_ATTEMPTS = 3;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      stream: true, // ← el arreglo del timeout: los bytes salen de inmediato
      system,
      messages,
    }),
  });

  if (res.ok) return res;

  const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
  if (retryable && attempt < MAX_ATTEMPTS - 1) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 8000)
      : 2 ** attempt * 1000 + Math.random() * 500;
    await new Promise((r) => setTimeout(r, waitMs));
    return callClaude({ apiKey, system, messages, attempt: attempt + 1 });
  }

  const detail = await res.text().catch(() => '');
  throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Traducción del SSE de Anthropic a NDJSON simple para el navegador
// ---------------------------------------------------------------------------

// Se emite una línea de JSON por evento. El navegador lo lee incremental sin
// necesitar un parser de SSE:
//   {"type":"text","text":"..."}                    fragmento de texto
//   {"type":"done","usage":{...}}                   terminó bien
//   {"type":"error","error":"...","message":"..."}  falló a mitad de camino
function toNdjson(body, code) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      const reader = body.getReader();
      let buffer = '';
      let usage = null;
      let emittedText = false;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            let ev;
            try { ev = JSON.parse(raw); } catch { continue; }

            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              emittedText = true;
              emit({ type: 'text', text: ev.delta.text });
            } else if (ev.type === 'message_start' && ev.message?.usage) {
              usage = { ...(usage ?? {}), ...ev.message.usage };
            } else if (ev.type === 'message_delta' && ev.usage) {
              usage = { ...(usage ?? {}), ...ev.usage };
            } else if (ev.type === 'error') {
              // Error a mitad del stream. Se avisa; no se finge éxito.
              console.error('[synoma] error en stream:', ev.error);
              emit({
                type: 'error',
                error: 'stream_error',
                message: 'El motor se cortó a mitad de la respuesta. Probá de nuevo.',
              });
              controller.close();
              return;
            }
          }
        }

        if (!emittedText) {
          emit({
            type: 'error',
            error: 'empty_response',
            message: 'El motor devolvió una respuesta vacía. Probá de nuevo.',
          });
        } else {
          // usage queda en los logs de Netlify: sirve para ver el costo real
          // por cliente, incluido cuánto ahorró el caché.
          if (usage) console.log('[synoma] uso', JSON.stringify({ code, ...usage }));
          emit({ type: 'done', usage });
        }
      } catch (e) {
        console.error('[synoma] stream interrumpido:', e?.message ?? e);
        emit({
          type: 'error',
          error: 'stream_aborted',
          message: 'Se cortó la conexión con el motor. Probá de nuevo.',
        });
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function profileBlock(p) {
  const part = (v, max, vacio) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : vacio;
  };
  return [
    '=== PERFIL DEL CLIENTE (su identidad — usala en TODO) ===',
    '--- SU MANUAL DE TRANSFORMACIÓN ---',
    part(p.manual, LIMITS.manual, '(no cargado — pedile que lo cargue en "Mi identidad")'),
    '--- SU OFERTA EN UNA PÁGINA ---',
    part(p.oferta, LIMITS.oferta, '(no cargada)'),
    '--- FRASES TEXTUALES DE SU ENCUESTA ---',
    part(p.encuesta, LIMITS.encuesta, '(no cargadas)'),
    '=== FIN DEL PERFIL ===',
  ].join('\n');
}

function parseCodes(raw) {
  return String(raw ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

// Cuenta mensajes por código y por día en Netlify Blobs.
//
// Decisión consciente: si Blobs falla, se deja pasar la petición (fail open)
// en lugar de bloquearla. Un problema del contador no debería tumbar el
// producto. El costo es que durante una caída de Blobs no hay tope — la
// protección de fondo sigue siendo el chequeo de origen y el de código.
async function bumpUsage(code, limit) {
  try {
    const store = getStore('synoma-uso');
    const key = `${code}:${new Date().toISOString().slice(0, 10)}`; // FND-ANA1:2026-07-30
    const current = Number((await store.get(key)) ?? 0);
    if (current >= limit) return { exceeded: true, count: current };
    await store.set(key, String(current + 1));
    return { exceeded: false, count: current + 1 };
  } catch (e) {
    console.warn('[synoma] contador de uso no disponible, se deja pasar:', e?.message ?? e);
    return { exceeded: false, count: -1 };
  }
}

// Sin CORS por defecto: la app se sirve del mismo dominio que la función, así
// que no lo necesita. Antes estaba en '*', que habilitaba a cualquier sitio del
// mundo a llamar la función con un código filtrado.
function corsFor(req) {
  const allowed = parseOrigins(process.env.SYNOMA_ALLOWED_ORIGINS);
  const origin = req.headers.get('origin');
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // mismo origen (o cliente no-navegador: lo frena el código + el tope)
  const allowed = parseOrigins(process.env.SYNOMA_ALLOWED_ORIGINS);
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

function parseOrigins(raw) {
  return String(raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function fail(status, error, message, cors) {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
