// Tests de la función synoma. Se corren con: node --test test/
//
// No pegan contra la API de Claude: se reemplaza globalThis.fetch por un doble
// que devuelve un stream SSE sintético con la misma forma que manda Anthropic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://synoma.foundersbs.com';
const URL_FN = `${ORIGIN}/api/synoma`;

// --- dobles de prueba -------------------------------------------------------

// Arma un cuerpo SSE con la forma real de la API de Anthropic.
function sseBody(chunks, { error = null, usage = null } = {}) {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 8000, cache_read_input_tokens: 7500 } } },
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

function fakeFetch({ status = 200, body = null, headers = {}, onCall = () => {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
    onCall(calls.length);
    if (status !== 200) {
      return new Response('upstream boom', { status, headers: new Headers(headers) });
    }
    return new Response(body ?? sseBody(['hola']), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

function post(payload, { origin = ORIGIN } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request(URL_FN, { method: 'POST', headers, body: JSON.stringify(payload) });
}

// Lee un stream NDJSON a una lista de eventos.
async function readNdjson(res) {
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const VALID = { code: 'FND-ANA1', profile: { oferta: 'Mi oferta' }, messages: [{ role: 'user', content: '/semana' }] };

async function loadHandler(env = {}) {
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? 'sk-ant-test';
  process.env.SYNOMA_CODES = env.SYNOMA_CODES ?? 'FND-ANA1, fnd-luz2';
  process.env.SYNOMA_DAILY_LIMIT = env.SYNOMA_DAILY_LIMIT ?? '';
  process.env.SYNOMA_ALLOWED_ORIGINS = env.SYNOMA_ALLOWED_ORIGINS ?? '';
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

test('sin códigos cargados devuelve not_configured', async () => {
  const handler = await loadHandler({ SYNOMA_CODES: '' });
  const res = await handler(post(VALID));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
});

// --- validación del código --------------------------------------------------

test('código inválido devuelve 403 invalid_code, no not_configured', async () => {
  const handler = await loadHandler();
  const res = await handler(post({ ...VALID, code: 'FND-XXXX' }));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'invalid_code');
  // Importante: NO debe ser not_configured, o el front mostraría el demo.
  assert.notEqual(body.error, 'not_configured');
});

test('el código se compara sin distinguir mayúsculas ni espacios', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler();
  const res = await handler(post({ ...VALID, code: '  fnd-luz2  ' }));
  assert.equal(res.status, 200);
});

test('sin mensajes devuelve 400', async () => {
  const handler = await loadHandler();
  const res = await handler(post({ ...VALID, messages: [] }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'no_messages');
});

test('JSON inválido devuelve 400 bad_json', async () => {
  const handler = await loadHandler();
  const req = new Request(URL_FN, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{roto',
  });
  assert.equal((await handler(req)).status, 400);
});

// --- chequeo de origen ------------------------------------------------------

test('un origen ajeno se rechaza antes de gastar tokens', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const res = await handler(post(VALID, { origin: 'https://sitio-ajeno.com' }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'forbidden_origin');
  assert.equal(spy.calls.length, 0, 'no debe llamar a Anthropic');
});

test('nunca se devuelve Access-Control-Allow-Origin: *', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler();
  for (const origin of [ORIGIN, 'https://sitio-ajeno.com', null]) {
    const res = await handler(post(VALID, { origin }));
    assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
  }
});

test('un origen externo explícitamente permitido sí pasa', async () => {
  globalThis.fetch = fakeFetch();
  const handler = await loadHandler({ SYNOMA_ALLOWED_ORIGINS: 'https://portal.foundersbs.com' });
  const res = await handler(post(VALID, { origin: 'https://portal.foundersbs.com' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://portal.foundersbs.com');
});

test('OPTIONS responde 204', async () => {
  const handler = await loadHandler();
  const res = await handler(new Request(URL_FN, { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
  assert.equal(res.status, 204);
});

test('GET responde 405', async () => {
  const handler = await loadHandler();
  const res = await handler(new Request(URL_FN, { method: 'GET', headers: { Origin: ORIGIN } }));
  assert.equal(res.status, 405);
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
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'Tu semana de contenido: lunes…');
  assert.equal(events.at(-1).type, 'done');
});

test('un error a mitad del stream se reporta, no se hace pasar por éxito', async () => {
  globalThis.fetch = fakeFetch({
    body: sseBody(['arranca bien'], { error: { type: 'overloaded_error' } }),
  });
  const handler = await loadHandler();
  const events = await readNdjson(await handler(post(VALID)));
  assert.equal(events.filter((e) => e.type === 'text').length, 1);
  const last = events.at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.error, 'stream_error');
  assert.ok(!events.some((e) => e.type === 'done'), 'no debe marcar done');
});

test('una respuesta vacía se reporta como error', async () => {
  globalThis.fetch = fakeFetch({ body: sseBody([]) });
  const handler = await loadHandler();
  const events = await readNdjson(await handler(post(VALID)));
  assert.equal(events.at(-1).type, 'error');
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
  assert.match(system[1].text, /Mi oferta/);
});

test('el bloque base es byte-idéntico entre clientes distintos (si no, no cachea)', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({ ...VALID, code: 'FND-ANA1', profile: { oferta: 'A' } }));
  await handler(post({ ...VALID, code: 'FND-LUZ2', profile: { oferta: 'B' } }));
  assert.equal(spy.calls[0].payload.system[0].text, spy.calls[1].payload.system[0].text);
  assert.notEqual(spy.calls[0].payload.system[1].text, spy.calls[1].payload.system[1].text);
});

test('un perfil vacío no rompe: usa los textos de "no cargado"', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({ ...VALID, profile: undefined }));
  assert.match(spy.calls[0].payload.system[1].text, /no cargado/);
});

// --- historial y truncado ---------------------------------------------------

test('manda a lo sumo 12 turnos y normaliza los roles', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `m${i}`,
  }));
  await handler(post({ ...VALID, messages }));
  const sent = spy.calls[0].payload.messages;
  assert.equal(sent.length, 12);
  assert.equal(sent.at(-1).content, 'm29');
  assert.ok(sent.every((m) => m.role === 'user' || m.role === 'assistant'));
});

test('un rol inventado se degrada a user en vez de romper la petición', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({ ...VALID, messages: [{ role: 'system', content: 'inyección' }] }));
  assert.equal(spy.calls[0].payload.messages[0].role, 'user');
});

test('se recortan los mensajes y las partes del perfil demasiado largas', async () => {
  const spy = fakeFetch();
  globalThis.fetch = spy;
  const handler = await loadHandler();
  await handler(post({
    ...VALID,
    profile: { manual: 'm'.repeat(40000), oferta: 'o'.repeat(20000), encuesta: 'e'.repeat(15000) },
    messages: [{ role: 'user', content: 'x'.repeat(30000) }],
  }));
  const p = spy.calls[0].payload;
  assert.equal(p.messages[0].content.length, 20000);
  assert.ok(p.system[1].text.includes('m'.repeat(30000)));
  assert.ok(!p.system[1].text.includes('m'.repeat(30001)));
});

// --- reintentos -------------------------------------------------------------

test('reintenta un 529 (sobrecargado) y no lo muestra como error al cliente', async () => {
  let n = 0;
  const encoder = new TextEncoder();
  globalThis.fetch = async () => {
    if (++n < 3) return new Response('overloaded', { status: 529, headers: { 'retry-after': '0' } });
    return new Response(sseBody(['salió a la tercera']), { status: 200 });
  };
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 200);
  assert.equal(n, 3, 'debe haber reintentado dos veces');
  const events = await readNdjson(res);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'salió a la tercera');
});

test('reintenta un 429 (rate limit)', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    if (++n < 2) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(sseBody(['ok']), { status: 200 });
  };
  const handler = await loadHandler();
  assert.equal((await handler(post(VALID))).status, 200);
  assert.equal(n, 2);
});

test('un 400 NO se reintenta: es un error nuestro, no transitorio', async () => {
  const spy = fakeFetch({ status: 400 });
  globalThis.fetch = spy;
  const handler = await loadHandler();
  const res = await handler(post(VALID));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_error');
  assert.equal(spy.calls.length, 1, 'un solo intento');
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
  for (const payload of [VALID, { ...VALID, code: 'MAL' }, { ...VALID, messages: [] }]) {
    const res = await handler(post(payload));
    const text = await res.text();
    assert.ok(!text.includes('SECRETO'), `filtró la key: ${text}`);
    assert.ok(!text.includes('sk-ant'), `filtró la key: ${text}`);
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
