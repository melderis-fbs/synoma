// Tests de la función synoma (el chat).
//
// No pegan contra la API de Claude ni contra Postgres: se reemplaza
// globalThis.fetch por un doble que devuelve un stream SSE con la misma forma
// que manda Anthropic, y se inyecta una base falsa por la costura
// usarSqlDePrueba de _db.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usarSqlDePrueba } from '../netlify/functions/_db.js';

const ORIGIN = 'https://synoma.foundersbs.com';
const URL_FN = `${ORIGIN}/api/synoma`;
const TOKEN = 'token-de-prueba';

// --- dobles de prueba -------------------------------------------------------

// Arma un cuerpo SSE con la forma real de la API de Anthropic.
function sseBody(chunks, { error = null, usage = null } = {}) {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 500, cache_read_input_tokens: 7500 } } },
    ...chunks.map((t) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } })),
  ];
  if (error) events.push({ type: 'error', error });
  else events.push({ type: 'message_delta', usage: usage ?? { output_tokens: 42 } }, { type: 'message_stop' });

  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ev of events) {
        c.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      }
      c.close();
    },
  });
}

function fakeFetch({ status = 200, body = null, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
    if (status !== 200) return new Response('upstream boom', { status, headers: new Headers(headers) });
    return new Response(body ?? sseBody(['hola']), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

// Base de datos falsa. Reconoce las consultas por una palabra clave del SQL y
// devuelve lo que corresponda; registra todo para poder afirmar sobre las
// escrituras (por ejemplo, que el uso se registró).
function fakeDb({
  sesion = { id: 'cli-1', email: 'ana@ejemplo.com', nombre: 'Ana', acceso: 'activo', origen_acceso: 'founders', sesion_id: 's-1' },
  perfil = { manual: 'Mi manual', oferta: 'Mi oferta', encuesta: 'Mis frases' },
  mensajesHoy = 0,
  fallar = null,   // 'sesion' | 'perfil' | 'uso'
} = {}) {
  const consultas = [];

  const sql = async (strings) => {
    const texto = Array.isArray(strings) ? strings.join('?') : String(strings);
    consultas.push(texto);

    if (texto.includes('FROM sesiones')) {
      if (fallar === 'sesion') throw new Error('base caída');
      return sesion ? [sesion] : [];
    }
    if (texto.includes('FROM perfiles')) {
      if (fallar === 'perfil') throw new Error('base caída');
      return perfil ? [perfil] : [];
    }
    if (texto.includes('FROM uso_diario')) {
      return [{ mensajes: mensajesHoy }];
    }
    if (texto.includes('INTO uso_diario')) {
      if (fallar === 'uso') throw new Error('base caída');
      return [];
    }
    return [];   // los UPDATE de ultimo_uso / ultimo_acceso
  };

  sql.consultas = consultas;
  sql.escribioUso = () => consultas.some((c) => c.includes('INTO uso_diario'));
  return sql;
}

function post(payload, { origin = ORIGIN, cookie = `synoma_sesion=${TOKEN}` } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return new Request(URL_FN, { method: 'POST', headers, body: JSON.stringify(payload) });
}

async function readNdjson(res) {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const VALID = { messages: [{ role: 'user', content: '/semana' }] };

async function loadHandler(env = {}, db = fakeDb()) {
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? 'sk-ant-test';
  process.env.DATABASE_URL = env.DATABASE_URL ?? 'postgresql://prueba';
  process.env.SYNOMA_DAILY_LIMIT = env.SYNOMA_DAILY_LIMIT ?? '';
  process.env.SYNOMA_ALLOWED_ORIGINS = env.SYNOMA_ALLOWED_ORIGINS ?? '';
  process.env.RENOVACION_URL = env.RENOVACION_URL ?? '';
  usarSqlDePrueba(db);
  const mod = await import('../netlify/functions/synoma.js?t=' + Math.random());
  return mod.default;
}

// --- configuración del servidor --------------------------------------------

test('sin API key devuelve not_configured (la única condición que habilita el demo)', async () => {
  const handler = await loadHandler({ ANTHROPIC_API_KEY: '' });
  const res = await handler(post(VALID));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

test('sin base de datos devuelve not_configured', async () => {
  const handler = await loadHandler({ DATABASE_URL: '' });
  const res = await handler(post(VALID));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

// --- sesión -----------------------------------------------------------------

test('sin cookie devuelve 401 sin_sesion, no not_configured', async () => {
  const handler = await loadHandler({}, fakeDb());
  const res = await handler(post(VALID, { cookie: null }));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'sin_sesion');
  // Si fuera not_configured, el front mostraría el contenido de ejemplo.
  assert.notEqual(body.error, 'not_configured');
});

test('con una cookie desconocida devuelve 401', async () => {
  const handler = await loadHandler({}, fakeDb({ sesion: null }));
  const res = await handler(post(VALID, { cookie: 'synoma_sesion=inventado' }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'sin_sesion');
});

test('a quien le sacaron el acceso se le ofrece renovar, no un error', async () => {
  const db = fakeDb({
    sesion: { id: 'cli-1', email: 'ex@ejemplo.com', nombre: 'Ex', acceso: 'suspendido', origen_acceso: 'founders', sesion_id: 's-1' },
  });
  const handler = await loadHandler({ RENOVACION_URL: 'https://pago.ejemplo.com' }, db);
  const res = await handler(post(VALID));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'acceso_terminado');
  assert.equal(body.renovacion_url, 'https://pago.ejemplo.com');
});

test('la sesión suspendida no llega a gastar tokens', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const db = fakeDb({
    sesion: { id: 'cli-1', email: 'ex@x.com', nombre: null, acceso: 'suspendido', origen_acceso: 'founders', sesion_id: 's-1' },
  });
  const handler = await loadHandler({}, db);
  await handler(post(VALID));
  assert.equal(spy.calls.length, 0);
});

// --- perfil -----------------------------------------------------------------

test('sin perfil cargado devuelve 409 y no gasta tokens', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler({}, fakeDb({ perfil: null }));
  const res = await handler(post(VALID));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'sin_perfil');
  assert.equal(spy.calls.length, 0, 'sin oferta escribiría genérico: mejor no llamar');
});

test('un perfil sin oferta cuenta como sin perfil', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler({}, fakeDb({ perfil: { manual: 'algo', oferta: '', encuesta: '' } }));
  assert.equal((await handler(post(VALID))).status, 409);
});

test('el perfil sale de la base, no del navegador', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler({}, fakeDb({
    perfil: { manual: 'MANUAL-DE-LA-BASE', oferta: 'OFERTA-DE-LA-BASE', encuesta: '' },
  }));
  // El cliente manda un perfil inventado: tiene que ser ignorado.
  await handler(post({ ...VALID, profile: { oferta: 'INYECTADA-POR-EL-CLIENTE' } }));

  const { system } = spy.calls[0].payload;
  assert.match(system[1].text, /OFERTA-DE-LA-BASE/);
  assert.ok(!system[1].text.includes('INYECTADA-POR-EL-CLIENTE'));
});

// --- tope de uso ------------------------------------------------------------

test('al llegar al tope diario devuelve 429 sin gastar tokens', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler({ SYNOMA_DAILY_LIMIT: '5' }, fakeDb({ mensajesHoy: 5 }));
  const res = await handler(post(VALID));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'daily_limit');
  assert.equal(spy.calls.length, 0);
});

test('debajo del tope pasa', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler({ SYNOMA_DAILY_LIMIT: '5' }, fakeDb({ mensajesHoy: 4 }));
  assert.equal((await handler(post(VALID))).status, 200);
});

test('registra el uso al terminar la respuesta', async () => {
  globalThis.fetch = fakeFetch();
  const db = fakeDb();
  const handler = await loadHandler({}, db);
  const res = await handler(post(VALID));
  await readNdjson(res);                       // consume el stream
  await new Promise((r) => setTimeout(r, 20));  // el registro no bloquea la respuesta
  assert.ok(db.escribioUso(), 'sin esto no habría costo por cliente');
});

test('si falla registrar el uso, la respuesta del cliente no se rompe', async () => {
  globalThis.fetch = fakeFetch({ body: sseBody(['texto bueno']) });
  const handler = await loadHandler({}, fakeDb({ fallar: 'uso' }));
  const events = await readNdjson(await handler(post(VALID)));
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'texto bueno');
  assert.equal(events.at(-1).type, 'done');
});

// --- fallos de la base ------------------------------------------------------

test('si la base no responde al leer la sesión devuelve db_error, no not_configured', async () => {
  const handler = await loadHandler({}, fakeDb({ fallar: 'sesion' }));
  const res = await handler(post(VALID));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'db_error');
});

test('si la base no responde al leer el perfil no se inventa un perfil vacío', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler({}, fakeDb({ fallar: 'perfil' }));
  const res = await handler(post(VALID));
  assert.equal(res.status, 503);
  assert.equal(spy.calls.length, 0, 'llamar con perfil vacío daría contenido genérico');
});

// --- chequeo de origen ------------------------------------------------------

test('un origen ajeno se rechaza antes de gastar tokens', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const res = await handler(post(VALID, { origin: 'https://sitio-ajeno.com' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden_origin');
  assert.equal(spy.calls.length, 0);
});

test('nunca se devuelve Access-Control-Allow-Origin: *', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler();
  for (const origin of [ORIGIN, 'https://sitio-ajeno.com', null]) {
    const res = await handler(post(VALID, { origin }));
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  }
});

test('OPTIONS responde 204 y GET responde 405', async () => {
  const handler = await loadHandler();
  const opt = await handler(new Request(URL_FN, { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
  assert.equal(opt.status, 204);
  const get = await handler(new Request(URL_FN, { method: 'GET', headers: { Origin: ORIGIN } }));
  assert.equal(get.status, 405);
});

// --- payload ----------------------------------------------------------------

test('sin mensajes devuelve 400', async () => {
  const handler = await loadHandler();
  const res = await handler(post({ messages: [] }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'no_messages');
});

test('JSON inválido devuelve 400 bad_json', async () => {
  const handler = await loadHandler();
  const req = new Request(URL_FN, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: `synoma_sesion=${TOKEN}` },
    body: '{roto',
  });
  assert.equal((await handler(req)).status, 400);
});

// --- streaming --------------------------------------------------------------

test('pide streaming a la API (el arreglo del timeout)', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post(VALID));
  assert.equal(spy.calls[0].payload.stream, true);
});

test('traduce el SSE de Anthropic a NDJSON y arma el texto completo', async () => {
  globalThis.fetch = fakeFetch({ body: sseBody(['Tu semana', ' de contenido', ': lunes…']) });
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);

  const events = await readNdjson(res);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    'Tu semana de contenido: lunes…');
  assert.equal(events.at(-1).type, 'done');
});

test('un error a mitad del stream se reporta, no se hace pasar por éxito', async () => {
  globalThis.fetch = fakeFetch({ body: sseBody(['arranca bien'], { error: { type: 'overloaded_error' } }) });
  const handler = await loadHandler();
  const events = await readNdjson(await handler(post(VALID)));
  assert.equal(events.filter((e) => e.type === 'text').length, 1);
  assert.equal(events.at(-1).type, 'error');
  assert.ok(!events.some((e) => e.type === 'done'), 'no debe marcar done');
});

test('una respuesta vacía se reporta como error', async () => {
  globalThis.fetch = fakeFetch({ body: sseBody([]) });
  const handler = await loadHandler();
  const events = await readNdjson(await handler(post(VALID)));
  assert.equal(events.at(-1).error, 'empty_response');
});

// --- prompt caching ---------------------------------------------------------

test('el system va en dos bloques, ambos con cache_control', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post(VALID));

  const { system } = spy.calls[0].payload;
  assert.equal(system.length, 2, 'bloque global + bloque por cliente');
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' });
  assert.match(system[0].text, /^Sos Synoma/, 'bloque 1: el prompt base, idéntico para todos');
  assert.match(system[1].text, /PERFIL DEL CLIENTE/, 'bloque 2: el perfil');
});

test('el bloque base es byte-idéntico entre clientes distintos (si no, no cachea)', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;

  const h1 = await loadHandler({}, fakeDb({ perfil: { manual: '', oferta: 'A', encuesta: '' } }));
  await h1(post(VALID));
  const h2 = await loadHandler({}, fakeDb({ perfil: { manual: '', oferta: 'B', encuesta: '' } }));
  await h2(post(VALID));

  assert.equal(spy.calls[0].payload.system[0].text, spy.calls[1].payload.system[0].text);
  assert.notEqual(spy.calls[0].payload.system[1].text, spy.calls[1].payload.system[1].text);
});

// --- historial --------------------------------------------------------------

test('manda a lo sumo 12 turnos y normaliza los roles', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `m${i}`,
  }));
  await handler(post({ messages }));

  const enviados = spy.calls[0].payload.messages;
  assert.equal(enviados.length, 12);
  assert.equal(enviados.at(-1).content, 'm29');
  assert.ok(enviados.every((m) => m.role === 'user' || m.role === 'assistant'));
});

test('un rol inventado se degrada a user en vez de romper la petición', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({ messages: [{ role: 'system', content: 'inyección' }] }));
  assert.equal(spy.calls[0].payload.messages[0].role, 'user');
});

test('se recortan los mensajes demasiado largos', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({ messages: [{ role: 'user', content: 'x'.repeat(30000) }] }));
  assert.equal(spy.calls[0].payload.messages[0].content.length, 20000);
});

// --- reintentos -------------------------------------------------------------

test('reintenta un 529 (sobrecargado) y no lo muestra como error al cliente', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    if (++n < 3) return new Response('overloaded', { status: 529, headers: { 'retry-after': '0' } });
    return new Response(sseBody(['salió a la tercera']), { status: 200 });
  };
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 200);
  assert.equal(n, 3, 'debe haber reintentado dos veces');
});

test('un 400 NO se reintenta: es un error nuestro, no transitorio', async () => {
  const spy = fakeFetch({ status: 400 });
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_error');
  assert.equal(spy.calls.length, 1);
});

test('si se agotan los reintentos devuelve 502 upstream_error, no not_configured', async () => {
  const spy = fakeFetch({ status: 529, headers: { 'retry-after': '0' } });
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_error');
  assert.equal(spy.calls.length, 3);
});

// --- la API key nunca sale hacia el cliente ---------------------------------

test('ninguna respuesta de error filtra la API key', async () => {
  globalThis.fetch = fakeFetch({ status: 500 });
  const handler = await loadHandler({ ANTHROPIC_API_KEY: 'sk-ant-SECRETO-NO-FILTRAR' });
  for (const payload of [VALID, { messages: [] }]) {
    const texto = await (await handler(post(payload))).text();
    assert.ok(!texto.includes('SECRETO'), `filtró la key: ${texto}`);
    assert.ok(!texto.includes('sk-ant'), `filtró la key: ${texto}`);
  }
});

test('la key va en el header x-api-key, no en el cuerpo', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post(VALID));
  assert.equal(spy.calls[0].init.headers['x-api-key'], 'sk-ant-test');
  assert.ok(!spy.calls[0].init.body.includes('sk-ant'));
});

// --- modelo -----------------------------------------------------------------

test('usa claude-sonnet-5', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post(VALID));
  assert.equal(spy.calls[0].payload.model, 'claude-sonnet-5');
  assert.equal(spy.calls[0].payload.max_tokens, 2500);
});
