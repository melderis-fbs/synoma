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
import { guardarSiEsPieza, ampliarPieza, resumenParaRacha, bloqueDeRacha } from './_biblioteca.js';

const MODEL = 'claude-sonnet-5';
// Cuánto puede escribir Claude en una respuesta.
//
// Esto NO es un presupuesto de dinero (se paga lo que escribe, no el tope): es un
// presupuesto de TIEMPO. Netlify corta la función a los 10 s (26-30 s si te lo
// subieron) y el streaming no exime de ese tope, porque cuenta la duración total
// de la invocación.
//
// El número por defecto sale de una cuenta que hay que hacer y no de un gusto:
// Claude escribe a ~60-80 tokens por segundo, así que 900 tokens son unos 12
// segundos de generación. Con el tope de 10 s de Netlify (26-30 s si te lo
// subieron) eso entra. 2.200 tokens serían 37 segundos: NO entran, y el resultado
// es un 504 en el que se pierde todo.
//
// Que sea chico no acorta las respuestas: cuando una se corta, el navegador pide
// la continuación solo y la pega en la misma burbuja (ver `truncada`). El cliente
// ve una respuesta larga; abajo son varios pedidos cortos, cada uno dentro del
// tope.
const MAX_TOKENS = Number(process.env.SYNOMA_MAX_TOKENS) || 900;

// Cuándo cortar por nuestra cuenta, antes de que corte Netlify.
//
// Es la diferencia entre dos finales muy distintos para el cliente:
//   · Nosotros cortamos → tiene el texto que llegó, queda guardado, y sigue solo.
//   · Corta Netlify → 504, se pierde TODO, y ni siquiera es JSON.
//
// El valor por defecto es conservador porque no sabemos si el sitio tiene el tope
// de 10 s o el de 26. Si te lo subieron a 26, poné SYNOMA_DEADLINE_MS=22000: van a
// hacer falta menos vueltas y todo va a salir más rápido.
const DEADLINE_MS = Number(process.env.SYNOMA_DEADLINE_MS) || 8500;

// Hasta cuándo se puede reintentar una respuesta vacía.
//
// Esto es la lección de un error propio: la primera versión del reintento no
// miraba el reloj. Si el primer intento se comía 12 segundos y volvía vacío, el
// segundo empujaba el total por encima del tope de Netlify, la plataforma mataba
// la función y el navegador recibía un 502 que ni siquiera es JSON. O sea que un
// arreglo pensado para que el cliente no viera un error terminaba causándole uno
// peor y menos diagnosticable.
//
// Pasados estos milisegundos ya no hay presupuesto para otra llamada completa:
// se le informa el problema, que es recuperable, en lugar de arriesgar el 502.
const MS_PARA_REINTENTAR = Number(process.env.SYNOMA_MS_REINTENTO) || 7000;

const MAX_CHARS_MENSAJE = 20000;
const DEFAULT_DAILY_LIMIT = 60;

// Envoltorio de último recurso.
//
// Si algo tira una excepción que no previmos, Netlify devuelve su propia página
// de error, que NO es JSON. El navegador entonces no puede leer ni el código ni
// el mensaje, y le muestra al cliente "No se pudo contactar al motor" — que es
// exactamente lo mismo que ve si se le cortó el wifi. Un error así es imposible
// de diagnosticar: no queda nada, ni para el cliente ni para nosotros.
//
// Con esto, cualquier falla inesperada sale como JSON con su código y queda en el
// log con el stack completo.
export default async (req) => {
  try {
    return await manejar(req);
  } catch (e) {
    console.error('[synoma] EXCEPCIÓN NO PREVISTA:', e?.stack ?? e?.message ?? e);
    return fail(500, 'error_interno',
      'Algo se rompió de nuestro lado. Ya quedó registrado — probá de nuevo en un minuto.',
      corsFor(req));
  }
};

const manejar = async (req) => {
  // El reloj arranca acá y no cuando empieza el stream. Lo que Netlify corta es
  // la invocación COMPLETA, así que el tiempo de la primera llamada a Anthropic
  // —que incluye la espera hasta el primer token— también cuenta.
  const inicioPedido = Date.now();
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

  // Si el navegador está pidiendo la continuación de una respuesta que se cortó,
  // manda el id de la pieza para que el texto se le pegue a esa y no cree una
  // nueva. Se valida la forma acá: un id mal armado hace que Postgres devuelva un
  // error de sintaxis, que llegaría al cliente como "la base falló".
  const continuaPieza = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(payload?.continua_pieza ?? '').trim())
    ? String(payload.continua_pieza).trim()
    : null;

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

  return new Response(toNdjson(upstream.body, cliente, pregunta, reintentar, inicioPedido, continuaPieza), {
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
function toNdjson(body, cliente, pregunta, reintentar = null, inicioPedido = Date.now(), continuaPieza = null) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));

      // Cerrar dos veces tira TypeError. Pasaba en la rama de error del stream:
      // se cerraba ahí y el `finally` volvía a cerrar, la excepción escapaba del
      // start() del ReadableStream y la respuesta HTTP se rompía entera. El
      // cliente veía "no se pudo contactar al motor" en lugar del error real.
      let cerrado = false;
      const cerrar = () => {
        if (cerrado) return;
        cerrado = true;
        try { controller.close(); } catch { /* ya estaba cerrado del otro lado */ }
      };
      let usage = null;
      let emittedText = false;
      let respuesta = '';
      let stopReason = null;
      // Para poder diagnosticar una respuesta vacía: sin saber qué eventos llegaron
      // no hay forma de distinguir "el modelo no escribió nada" de "el stream vino
      // con una forma que no sabemos leer".
      let tipos = new Set();
      let msHastaPrimerToken = null;
      const arranque = inicioPedido;

      // Guardar el turno pasa DESPUÉS de cerrar el stream y sin await: el
      // cliente ya tiene su respuesta completa en pantalla, y una base lenta no
      // tiene por qué hacerle esperar. Si falla, se pierde una entrada del
      // historial y queda en el log; no se pierde la respuesta.
      const persistir = () => {
        if (!respuesta.trim()) return;
        guardarTurno(cliente.id, pregunta, respuesta).catch((e) =>
          console.error('[synoma] no se pudo guardar el turno:', e?.message ?? e));
      };

      // Un byte de entrada, antes de esperar nada.
      //
      // Sirve para que la plataforma mande las cabeceras HTTP al navegador YA, sin
      // esperar la primera palabra de Claude. Sin esto, si el modelo tarda en
      // arrancar (y tarda más cuanto más grande es el prompt), Netlify puede matar
      // la función antes de haber mandado una sola cabecera: entonces reemplaza
      // toda la respuesta por un 504 en HTML y el navegador no puede leer nada.
      // Con la conexión ya abierta, lo peor que puede pasar es perder el final.
      emit({ type: 'ping' });

      // Lee un stream de la API de punta a punta, emitiendo el texto a medida que
      // llega. Devuelve 'error' si el stream reportó una falla, 'tiempo' si nos
      // quedamos sin presupuesto, o 'fin' si terminó.
      const bombear = async (cuerpo) => {
        const reader = cuerpo.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          // Cortamos NOSOTROS antes de que corte Netlify. Cortar acá deja al
          // cliente con el texto que llegó, guardado y con posibilidad de seguir;
          // que corte Netlify es un 504 en el que se pierde todo.
          if (emittedText && Date.now() - inicioPedido > DEADLINE_MS) {
            reader.cancel().catch(() => {});
            return 'tiempo';
          }

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
              // El tiempo hasta la PRIMERA palabra se mide aparte porque no se
              // arregla igual que el resto: depende del tamaño del prompt y de si
              // el caché pegó, no de cuánto escribe el modelo.
              if (!emittedText) msHastaPrimerToken = Date.now() - inicioPedido;
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
        const gastado = () => Date.now() - arranque;

        if (resultado === 'fin' && !emittedText && reintentar && gastado() < MS_PARA_REINTENTAR) {
          console.warn(`[synoma] respuesta vacía (eventos: ${[...tipos].join(',') || 'ninguno'}) `
            + `stop_reason=${stopReason ?? 'ninguno'} usage=${JSON.stringify(usage ?? {})} `
            + `comando=${(pregunta.match(/^\/\S+/) ?? [''])[0]} `
            + `gastado=${gastado()}ms — reintentando una vez`);
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

        // 'tiempo' NO es un error: hay texto válido en pantalla. Sigue por el
        // camino normal y se marca como truncada, para que el front pida el resto.
        if (resultado === 'error') {
          emit({
            type: 'error',
            error: 'stream_error',
            message: 'El motor se cortó a mitad de la respuesta. Probá de nuevo.',
          });
          // Se guarda lo que alcanzó a llegar: es lo que el cliente tiene en
          // pantalla, y que el historial diga otra cosa lo confundiría.
          persistir();
          cerrar();
          return;
        }

        if (!emittedText) {
          // Se deja TODO en el log: sin esto, "respuesta vacía" es un callejón sin
          // salida para diagnosticar. Los tipos de evento dicen si el modelo no
          // escribió nada o si el texto vino en una forma que no sabemos leer.
          console.error('[synoma] SIGUE VACÍA. '
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
            pieza = continuaPieza
              ? await ampliarPieza(cliente.id, continuaPieza, respuesta)
              : await guardarSiEsPieza(cliente.id, pregunta, respuesta);
          } catch (e) {
            console.error('[synoma] no se pudo guardar la pieza:', e?.message ?? e);
          }

          // Se deja en el log la duración y el motivo del corte. Es el dato que
          // permite distinguir "se cortó por el tope de tokens" de "lo mató el
          // tope de tiempo de Netlify", que se ven igual desde el navegador y se
          // arreglan de forma distinta.
          const duracion = Date.now() - arranque;
          const porTiempo = resultado === 'tiempo';
          const truncada = porTiempo || stopReason === 'max_tokens';

          // El desglose importa: si lo que se come el presupuesto es el tiempo
          // hasta la primera palabra, el problema es el tamaño del prompt (o que
          // el caché no pegó) y no cuánto escribe el modelo. Son arreglos
          // distintos y desde el navegador se ven igual.
          const reloj = `ttft=${msHastaPrimerToken ?? '?'}ms total=${duracion}ms`;
          if (truncada) {
            console.warn(`[synoma] cortada por ${porTiempo ? 'TIEMPO' : 'tokens'}: ${reloj} `
              + `caracteres=${respuesta.length} comando=${(pregunta.match(/^\/\S+/) ?? [''])[0]}`);
          } else {
            console.log(`[synoma] ok · ${reloj} · ${respuesta.length} caracteres`);
          }

          emit({
            type: 'done',
            usage,
            duracion_ms: duracion,
            ttft_ms: msHastaPrimerToken,
            // El front usa esto para pedir la continuación solo.
            truncada,
            motivo_corte: truncada ? (porTiempo ? 'tiempo' : 'tokens') : null,
            pieza: pieza ? { id: pieza.id, tipo: pieza.tipo, titulo: pieza.titulo } : null,
          });
          persistir();
        }
      } catch (e) {
        console.error('[synoma] stream interrumpido:', e?.message ?? e);
        try {
          emit({
            type: 'error',
            error: 'stream_aborted',
            message: 'Se cortó la conexión con el motor. Probá de nuevo.',
          });
        } catch { /* el consumidor ya se fue: no hay a quién avisarle */ }
        persistir();
      } finally {
        cerrar();
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
  let partes;
  let iso;
  try {
    partes = new Intl.DateTimeFormat('es-AR', {
      timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(ahora);
    iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ahora);
  } catch (e) {
    // Intl tira RangeError si el runtime no trae la base de zonas horarias
    // completa, o si la zona configurada no existe. Antes eso hacía caer TODA la
    // función por un bloque informativo: mejor la fecha en UTC que ninguna.
    console.warn(`[synoma] zona horaria "${zona}" no disponible, usando UTC:`, e?.message ?? e);
    iso = ahora.toISOString().slice(0, 10);
    partes = iso;
  }

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
