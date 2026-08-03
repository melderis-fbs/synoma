// Synoma Founders — motor de contenido
//
// Función serverless (Netlify Functions 2.0): identifica al cliente por su
// cookie de sesión, arma el prompt con su perfil y hace streaming de la
// respuesta de Claude.
//
// El prompt del sistema vive en ./_prompt.js — editalo ahí, no acá.
//
// Ya no hay códigos compartidos: el cliente se identifica por sesión (_auth.js),
// y el perfil y el contador de uso viven en la base de datos (_perfil.js). Eso
// cambia algo importante: antes el perfil lo mandaba el navegador en cada
// pedido, así que un navegador con el localStorage limpio enviaba un perfil
// vacío y Synoma escribía genérico sin que nadie se enterara.
//
// El historial de la charla también sale de la base (_conversacion.js). El
// navegador manda solo la pregunta nueva. Así el cliente sigue su conversación
// desde cualquier dispositivo, y nadie puede inyectar turnos falsos de
// "assistant" en el pedido para hacerle decir a Synoma lo que no dijo.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY       (requerida)  sk-ant-...
//   SYNOMA_DAILY_LIMIT      (opcional)   mensajes por cliente por día. Default 60.
//   RENOVACION_URL          (opcional)   a dónde mandar a quien terminó el programa.
//   SYNOMA_ALLOWED_ORIGINS  (opcional)   solo si la app se sirve desde OTRO dominio.

import { SYSTEM_BASE } from './_prompt.js';
import { clienteDeSesion } from './_auth.js';
import { urlDeBase } from './_db.js';
import { configPublica } from './_config.js';
import { leerPerfil, bloqueDePerfil, mensajesDeHoy, registrarUso } from './_perfil.js';
import { historial, paraElModelo, guardarTurno, MENSAJES_CONTEXTO } from './_conversacion.js';
import { guardarSiEsPieza, resumenParaRacha, bloqueDeRacha } from './_biblioteca.js';

const MODEL = 'claude-sonnet-5';
// Cuánto puede escribir Claude en una respuesta.
//
// Esto NO es un presupuesto de dinero (se paga lo que escribe, no el tope), es un
// presupuesto de TIEMPO: Netlify corta la función a los 10 s (26-30 s en los
// planes pagos) y el streaming no exime de ese tope, porque cuenta la duración
// total de la invocación. A ~60-80 tokens por segundo, 26 s son unos 2.000
// tokens. Por eso el tope está donde está: subirlo no arregla nada, solo cambia
// "se cortó por largo" (recuperable, se puede continuar) por "se cortó la
// conexión" (se pierde el resto).
const MAX_TOKENS = 2200;
const MAX_CHARS_MENSAJE = 20000;
const DEFAULT_DAILY_LIMIT = 60;

export default async (req) => {
  const cors = corsFor(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'Usá POST.', cors);

  // CORS solo evita que un sitio ajeno LEA la respuesta; la llamada igual se
  // ejecuta y consume tokens. Este chequeo la rechaza antes de gastar plata.
  if (!originAllowed(req)) {
    return fail(403, 'forbidden_origin', 'Origen no permitido.', cors);
  }

  // --- Config del servidor -------------------------------------------------
  // 503 = "el motor no está configurado". Es la ÚNICA condición que habilita el
  // modo demo en el front. Cualquier otro error se muestra como error.
  if (!process.env.ANTHROPIC_API_KEY || !urlDeBase()) {
    return fail(503, 'not_configured',
      'El motor todavía no está configurado en el servidor.', cors);
  }

  // --- ¿Quién es? ----------------------------------------------------------
  let cliente;
  try {
    cliente = await clienteDeSesion(req);
  } catch (e) {
    console.error('[synoma] fallo leyendo la sesión:', e?.message ?? e);
    return fail(503, 'db_error', 'No podemos verificar tu sesión ahora mismo.', cors);
  }

  if (!cliente) {
    return fail(401, 'sin_sesion', 'Tu sesión venció. Volvé a entrar con tu email.', cors);
  }
  if (cliente.suspendido) {
    return fail(403, 'acceso_terminado',
      'Tu acceso a Synoma terminó junto con el programa.', cors,
      { detalle: 'Podés seguir usándolo con una suscripción.',
        config: configPublica() });
  }

  // --- Payload -------------------------------------------------------------
  let payload;
  try {
    payload = await req.json();
  } catch {
    return fail(400, 'bad_json', 'El cuerpo de la petición no es JSON válido.', cors);
  }

  // Del navegador llega SOLO la pregunta nueva. El historial lo pone el servidor
  // desde la base: si viniera del cliente, cualquiera podría inventar turnos de
  // "assistant" y hacerle creer a Synoma que ya dijo algo que nunca dijo.
  const pregunta = extraerPregunta(payload);
  if (!pregunta) {
    return fail(400, 'no_messages', 'No llegó ningún mensaje.', cors);
  }

  // --- Tope de uso por cliente y por día -----------------------------------
  const limit = Number(process.env.SYNOMA_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT;
  try {
    if (await mensajesDeHoy(cliente.id) >= limit) {
      return fail(429, 'daily_limit',
        `Llegaste al tope de ${limit} mensajes por hoy. Mañana se renueva.`, cors);
    }
  } catch (e) {
    // Si el contador falla se deja pasar: un problema de medición no debería
    // tumbar el producto. Queda en el log para poder detectarlo.
    console.warn('[synoma] no se pudo leer el uso del día:', e?.message ?? e);
  }

  // --- El perfil sale de la base, no del navegador --------------------------
  let perfil = null;
  try {
    perfil = await leerPerfil(cliente.id);
  } catch (e) {
    console.error('[synoma] fallo leyendo el perfil:', e?.message ?? e);
    return fail(503, 'db_error', 'No pudimos leer tu identidad. Probá de nuevo.', cors);
  }

  if (!perfil?.oferta) {
    return fail(409, 'sin_perfil',
      'Primero cargá tu identidad: sin tu Oferta en Una Página, Synoma escribe genérico.', cors);
  }

  // --- System prompt en dos bloques cacheables -----------------------------
  // Bloque 1: SYSTEM_BASE — idéntico para todos los clientes, se cachea global.
  // Bloque 2: el perfil    — estable por cliente, se cachea por cliente.
  // Las lecturas de caché cuestan el 10% del precio normal de entrada.
  const system = [
    { type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: bloqueDePerfil(perfil), cache_control: { type: 'ephemeral' } },
  ];

  // El modelo no sabe qué día es. Sin esto contesta cosas como "no la grabes
  // hasta que me digas qué día es hoy", o inventa una cuenta de días mal hecha.
  // Va sin cache_control porque cambia todos los días: si fuera parte del prefijo
  // cacheado, invalidaría el caché de los 100 clientes cada medianoche.
  system.push({ type: 'text', text: bloqueDeFecha() });

  // Bloque 4, SOLO para /racha: el listado de su biblioteca con los estados.
  // /racha pregunta "¿qué publicaste de lo que planificamos?" y sin este dato el
  // modelo no tiene con qué contestar: pregunta de nuevo lo que ya está anotado.
  // Va sin cache_control y solo en este comando, para no pagar estos tokens en
  // cada mensaje.
  if (/^\/racha\b/i.test(pregunta)) {
    try {
      system.push({ type: 'text', text: bloqueDeRacha(await resumenParaRacha(cliente.id)) });
    } catch (e) {
      console.warn('[synoma] no se pudo leer la biblioteca para /racha:', e?.message ?? e);
    }
  }

  // --- Su memoria ----------------------------------------------------------
  // Sale de la base, no del navegador. Si la consulta falla se sigue adelante
  // sin historial: perder el contexto de la charla es molesto, quedarse sin
  // responder es peor.
  let previos = [];
  try {
    previos = await historial(cliente.id, MENSAJES_CONTEXTO);
  } catch (e) {
    console.warn('[synoma] no se pudo leer el historial:', e?.message ?? e);
  }

  const trimmed = paraElModelo([...previos, { role: 'user', content: pregunta }]);

  // --- Llamada a Claude, con streaming y reintentos ------------------------
  let upstream;
  try {
    upstream = await callClaude({ apiKey: process.env.ANTHROPIC_API_KEY, system, messages: trimmed });
  } catch (e) {
    console.error('[synoma] fallo llamando a Anthropic:', e?.message ?? e);
    return fail(502, 'upstream_error',
      'El motor no responde en este momento. Probá de nuevo en un minuto.', cors);
  }

  // A partir de acá el stream ya arrancó: los errores se emiten DENTRO del
  // stream, porque los headers HTTP ya salieron.
  // El reintento se pasa como función y no se llama acá: solo se usa si el stream
  // termina sin una sola palabra, que es el único momento en que reintentar es
  // invisible para el cliente.
  const reintentar = () => callClaude({
    apiKey: process.env.ANTHROPIC_API_KEY, system, messages: trimmed,
  });

  return new Response(toNdjson(upstream.body, cliente, pregunta, reintentar), {
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

// Una línea de JSON por evento. El navegador lo lee incremental sin necesitar un
// parser de SSE:
//   {"type":"text","text":"..."}                    fragmento de texto
//   {"type":"done","usage":{...}}                   terminó bien
//   {"type":"error","error":"...","message":"..."}  falló a mitad de camino
function toNdjson(body, cliente, pregunta, reintentar = null) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      let usage = null;
      let emittedText = false;
      let respuesta = '';
      let stopReason = null;
      // Para poder diagnosticar una respuesta vacía: sin saber qué eventos llegaron
      // no hay forma de distinguir "el modelo no escribió nada" de "el stream vino
      // con una forma que no sabemos leer".
      let tipos = new Set();
      const arranque = Date.now();

      // Guardar el turno pasa DESPUÉS de cerrar el stream y sin await: el
      // cliente ya tiene su respuesta completa en pantalla, y una base lenta no
      // tiene por qué hacerle esperar. Si falla, se pierde una entrada del
      // historial y queda en el log; no se pierde la respuesta.
      const persistir = () => {
        if (!respuesta.trim()) return;
        guardarTurno(cliente.id, pregunta, respuesta).catch((e) =>
          console.error('[synoma] no se pudo guardar el turno:', e?.message ?? e));
      };

      // Lee un stream de la API de punta a punta, emitiendo el texto a medida que
      // llega. Devuelve 'error' si el propio stream reportó una falla.
      const bombear = async (cuerpo) => {
        const reader = cuerpo.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

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
            tipos.add(ev.type === 'content_block_delta' ? `delta:${ev.delta?.type}` : ev.type);

            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              emittedText = true;
              respuesta += ev.delta.text;
              emit({ type: 'text', text: ev.delta.text });
            } else if (ev.type === 'message_start' && ev.message?.usage) {
              usage = { ...(usage ?? {}), ...ev.message.usage };
            } else if (ev.type === 'message_delta') {
              if (ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
              // Acá viene el motivo por el que el modelo dejó de escribir.
              // 'max_tokens' significa que la respuesta quedó cortada a mitad de
              // frase. Antes esto pasaba en silencio: el cliente recibía media
              // tabla y no tenía forma de saber que faltaba algo.
              if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
            } else if (ev.type === 'error') {
              console.error('[synoma] error en stream:', JSON.stringify(ev.error ?? {}).slice(0, 300));
              return 'error';
            }
          }
        }
        return 'fin';
      };

      try {
        let resultado = await bombear(body);

        // Respuesta vacía: se reintenta UNA vez y en silencio. Se puede hacer
        // justamente porque no salió ni un byte al navegador todavía, así que el
        // cliente no ve el reintento: ve la respuesta buena o el error, nunca las
        // dos cosas. Una completación vacía es un hipo transitorio de la API, y
        // hacer que el cliente vuelva a escribir su pedido por eso es hacerle
        // pagar a él un problema que no es suyo.
        if (resultado === 'fin' && !emittedText && reintentar) {
          console.warn(`[synoma] respuesta vacía (eventos: ${[...tipos].join(',') || 'ninguno'}) `
            + `stop_reason=${stopReason ?? 'ninguno'} usage=${JSON.stringify(usage ?? {})} `
            + `comando=${(pregunta.match(/^\/\S+/) ?? [''])[0]} — reintentando una vez`);
          try {
            const otra = await reintentar();
            if (otra?.body) {
              tipos = new Set();
              stopReason = null;
              resultado = await bombear(otra.body);
            }
          } catch (e) {
            console.error('[synoma] el reintento también falló:', e?.message ?? e);
          }
        }

        if (resultado === 'error') {
          emit({
            type: 'error',
            error: 'stream_error',
            message: 'El motor se cortó a mitad de la respuesta. Probá de nuevo.',
          });
          // Se guarda lo que alcanzó a llegar: es lo que el cliente tiene en
          // pantalla, y que el historial diga otra cosa lo confundiría.
          persistir();
          controller.close();
          return;
        }

        if (!emittedText) {
          // Se deja TODO en el log: sin esto, "respuesta vacía" es un callejón sin
          // salida para diagnosticar. Los tipos de evento dicen si el modelo no
          // escribió nada o si el texto vino en una forma que no sabemos leer.
          console.error('[synoma] SIGUE VACÍA tras el reintento. '
            + `eventos=${[...tipos].join(',') || 'ninguno'} `
            + `stop_reason=${stopReason ?? 'ninguno'} `
            + `usage=${JSON.stringify(usage ?? {})} `
            + `duracion=${Date.now() - arranque}ms `
            + `comando=${(pregunta.match(/^\/\S+/) ?? [''])[0]} `
            + `mensajes=${cliente.mensajes_enviados ?? '?'}`);

          emit({
            type: 'error',
            error: 'empty_response',
            message: 'El motor se quedó sin decir nada — es un hipo de la API, no algo que hiciste mal. Volvé a mandar el mismo mensaje.',
          });
        } else {
          if (usage) {
            // Sin await: registrar el uso no debe demorar la respuesta ni
            // tumbarla si la base está lenta.
            registrarUso(cliente.id, usage).catch((e) =>
              console.error('[synoma] no se pudo registrar el uso:', e?.message ?? e));
          }
          // La pieza SÍ se espera antes de avisar "done": el front muestra
          // "guardado en tu biblioteca" y esa frase tiene que ser verdad. Es un
          // INSERT y el texto ya salió completo, así que no demora nada visible.
          let pieza = null;
          try {
            pieza = await guardarSiEsPieza(cliente.id, pregunta, respuesta);
          } catch (e) {
            console.error('[synoma] no se pudo guardar la pieza:', e?.message ?? e);
          }

          // Se deja en el log la duración y el motivo del corte. Es el dato que
          // permite distinguir "se cortó por el tope de tokens" de "lo mató el
          // tope de tiempo de Netlify", que se ven igual desde el navegador y se
          // arreglan de forma distinta.
          const duracion = Date.now() - arranque;
          if (stopReason && stopReason !== 'end_turn') {
            console.warn(`[synoma] respuesta incompleta: stop_reason=${stopReason} duracion=${duracion}ms `
              + `caracteres=${respuesta.length} comando=${(pregunta.match(/^\/\S+/) ?? [''])[0]}`);
          } else {
            console.log(`[synoma] ok en ${duracion}ms, ${respuesta.length} caracteres`);
          }

          emit({
            type: 'done',
            usage,
            duracion_ms: duracion,
            // El front usa esto para mostrar el aviso y el botón de continuar.
            truncada: stopReason === 'max_tokens',
            pieza: pieza ? { id: pieza.id, tipo: pieza.tipo, titulo: pieza.titulo } : null,
          });
          persistir();
        }
      } catch (e) {
        console.error('[synoma] stream interrumpido:', e?.message ?? e);
        emit({
          type: 'error',
          error: 'stream_aborted',
          message: 'Se cortó la conexión con el motor. Probá de nuevo.',
        });
        persistir();
      } finally {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

// Sin CORS por defecto: la app se sirve del mismo dominio que la función, así
// que no lo necesita. Antes estaba en '*', que habilitaba a cualquier sitio del
// mundo a llamar la función.
function corsFor(req) {
  const allowed = parseOrigins(process.env.SYNOMA_ALLOWED_ORIGINS);
  const origin = req.headers.get('origin');
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true; // mismo origen
  if (parseOrigins(process.env.SYNOMA_ALLOWED_ORIGINS).includes(origin)) return true;
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

// La fecha de hoy, en la zona horaria del cliente (Argentina por defecto). Se
// arma con Intl para no depender de que el servidor esté en UTC.
export function bloqueDeFecha(ahora = new Date()) {
  const zona = process.env.SYNOMA_ZONA_HORARIA || 'America/Argentina/Buenos_Aires';
  const partes = new Intl.DateTimeFormat('es-AR', {
    timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(ahora);
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ahora);

  return [
    '=== HOY ===',
    `Hoy es ${partes} (${iso}).`,
    'Usá esta fecha para cualquier cuenta de días, plazo o calendario. NUNCA le preguntes al cliente qué día es: ya lo sabés.',
    '=== FIN ===',
  ].join('\n');
}

// El navegador manda { mensaje: "..." }. Se acepta también el formato viejo
// { messages: [...] } porque una pestaña abierta desde antes del deploy sigue
// mandando eso, y no hay motivo para romperle la sesión: se toma la última
// pregunta del cliente y el resto se descarta (el historial real está en la base).
function extraerPregunta(payload) {
  const directo = String(payload?.mensaje ?? '').slice(0, MAX_CHARS_MENSAJE).trim();
  if (directo) return directo;

  const lista = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = lista.length - 1; i >= 0; i--) {
    if (lista[i]?.role === 'assistant') continue;
    const texto = String(lista[i]?.content ?? '').slice(0, MAX_CHARS_MENSAJE).trim();
    if (texto) return texto;
  }
  return '';
}

function fail(status, error, message, cors, extra = {}) {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
