// Tests de la interfaz, en un navegador de verdad.
//
// Existen por un bug concreto: al pedir /semana no aparecía NADA. Ni texto ni
// error. Los 200 tests del servidor pasaban y no había forma de verlo desde ahí,
// porque el fallo estaba en cómo el navegador interpreta un stream que se
// termina sin cerrar (la plataforma mata la función a mitad de camino y el
// navegador ve un 200 y un stream que se acaba).
//
// Eso es lo peor que le puede pasar a este producto: una pantalla en blanco. El
// cliente no sabe si esperar, reintentar o avisar. Los casos de acá son los que
// nunca más pueden volver a quedar mudos.
//
// Se saltean si no hay Chromium ni playwright-core instalados, para que `npm
// test` siga andando en cualquier máquina y en el build de Netlify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const HTML_PATH = new URL('../public/index.html', import.meta.url);
const HTML = readFileSync(HTML_PATH, 'utf8');

// --- ¿se puede correr? ------------------------------------------------------

function buscarChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    if (!dir.startsWith('chromium')) continue;
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const ruta = `${base}/${dir}/${rel}`;
      if (existsSync(ruta)) return ruta;
    }
  }
  return null;
}

let chromium = null;
let executablePath = null;
try {
  ({ chromium } = await import('playwright-core'));
  executablePath = buscarChromium();
} catch { /* sin playwright: los tests se saltean */ }

const disponible = Boolean(chromium && executablePath);
const opciones = disponible ? {} : { skip: 'sin playwright-core o sin Chromium' };

// --- andamiaje ---------------------------------------------------------------

const ORIGEN = 'https://synoma.foundersbs.com';
const PIEZA = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tipo: 'plan', titulo: 'Mi semana' };

const ndjson = (lineas) => lineas.map((o) => JSON.stringify(o)).join('\n') + '\n';

// Abre la app con la API simulada. `responder` decide qué devuelve /api/synoma.
async function abrirApp(responder) {
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e.message)));

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.endsWith('/app')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (url.includes('/api/auth/sesion')) {
      return json({ sesion: { email: 'ana@x.com', nombre: 'Ana', perfil_cargado: true },
        config: { precio: '59', moneda: 'USD', renovacion_url: null } });
    }
    if (url.includes('/api/chat')) return json({ mensajes: [] });
    if (url.includes('/api/biblioteca')) return json({ piezas: [], etiquetas: { plan: 'Plan semanal' } });
    if (url.includes('/api/synoma')) {
      const cuerpo = JSON.parse(route.request().postData() || '{}');
      return route.fulfill({
        status: 200, contentType: 'application/x-ndjson',
        body: ndjson(responder(cuerpo)),
      });
    }
    // Las fuentes de Google no tienen que salir a internet en un test.
    if (url.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto(`${ORIGEN}/app`);
  await page.waitForSelector('#view-dash.active');
  return { browser, page, errores };
}

// Lo que ve el cliente en la última burbuja de Synoma.
async function respuesta(page) {
  return page.evaluate(() => {
    const bots = [...document.querySelectorAll('#msgs .msg.bot')];
    const ultima = bots[bots.length - 1];
    return {
      hay: bots.length,
      texto: ultima ? ultima.innerText.trim() : '',
      tieneBotonReintentar: Boolean(ultima?.querySelector('button')),
    };
  });
}

async function pedirSemana(page) {
  await page.click('text=Mi semana de contenido');
  // Con la API simulada la respuesta es inmediata; el margen es para el render.
  await page.waitForTimeout(700);
}

// --- los casos que no pueden quedar mudos -----------------------------------

test('el chat NUNCA queda en blanco: stream cortado sin una sola palabra', opciones, async () => {
  // Este es EL bug. La plataforma mata la función antes del primer token: el
  // navegador recibe 200, el ping, y el stream se termina. Sin detectarlo, no se
  // mostraba absolutamente nada.
  const { browser, page, errores } = await abrirApp(() => [{ type: 'ping' }]);
  await pedirSemana(page);

  const r = await respuesta(page);
  assert.ok(r.hay > 0, 'no apareció ninguna burbuja: el cliente se queda mirando la nada');
  assert.match(r.texto, /cortó la respuesta/i);
  assert.ok(r.tieneBotonReintentar, 'tiene que poder reintentar sin reescribir el pedido');
  assert.deepEqual(errores, []);
  await browser.close();
});

test('el chat NUNCA queda en blanco: stream cortado con texto a medias', opciones, async () => {
  const { browser, page, errores } = await abrirApp(() => [
    { type: 'ping' },
    { type: 'text', text: '| Lun | esto sí llegó |' },
  ]);
  await pedirSemana(page);

  const r = await respuesta(page);
  // Lo que llegó es válido: se conserva y se ofrece seguir.
  assert.match(r.texto, /esto sí llegó/);
  assert.match(r.texto, /quedó cortada/i);
  assert.deepEqual(errores, []);
  await browser.close();
});

test('el chat NUNCA queda en blanco: respuesta vacía del motor', opciones, async () => {
  const { browser, page } = await abrirApp(() => [
    { type: 'ping' },
    { type: 'error', error: 'empty_response', message: 'El motor se quedó sin decir nada.' },
  ]);
  await pedirSemana(page);

  const r = await respuesta(page);
  assert.match(r.texto, /sin decir nada/i);
  assert.ok(r.tieneBotonReintentar);
  await browser.close();
});

// --- el camino feliz ---------------------------------------------------------

test('una respuesta completa se convierte en la tarjeta de la biblioteca', opciones, async () => {
  const { browser, page, errores } = await abrirApp(() => [
    { type: 'ping' },
    { type: 'text', text: '| Día | Gancho |\n|---|---|\n| Lun | no vendo mentorías |' },
    { type: 'done', truncada: false, motivo_corte: null, usage: {}, ttft_ms: 90, pieza: PIEZA },
  ]);
  await pedirSemana(page);

  const r = await respuesta(page);
  assert.match(r.texto, /PLAN SEMANAL · GUARDADO/);
  assert.match(r.texto, /Mi semana/);
  // El texto completo no se pierde: queda a un toque.
  assert.match(r.texto, /Ver el texto acá/);
  assert.match(r.texto, /Ver mi calendario/);
  assert.deepEqual(errores, []);
  await browser.close();
});

test('"Ver el texto acá" devuelve el contenido completo', opciones, async () => {
  const { browser, page } = await abrirApp(() => [
    { type: 'ping' },
    { type: 'text', text: 'EL PLAN COMPLETO CON TODO EL DETALLE' },
    { type: 'done', truncada: false, usage: {}, pieza: PIEZA },
  ]);
  await pedirSemana(page);
  await page.click('text=Ver el texto acá');
  await page.waitForTimeout(200);

  const r = await respuesta(page);
  assert.match(r.texto, /EL PLAN COMPLETO CON TODO EL DETALLE/);
  await browser.close();
});

// --- la continuación automática ---------------------------------------------

test('una respuesta cortada se completa sola, en la misma burbuja', opciones, async () => {
  // Netlify corta la función antes de que termine un plan semanal, así que el
  // navegador pide el resto solo. El cliente tiene que ver UNA respuesta.
  let llamadas = 0;
  const { browser, page, errores } = await abrirApp((cuerpo) => {
    llamadas++;
    if (cuerpo.continua_pieza) {
      return [{ type: 'ping' }, { type: 'text', text: ' SEGUNDA PARTE' },
        { type: 'done', truncada: false, usage: {}, pieza: PIEZA }];
    }
    return [{ type: 'ping' }, { type: 'text', text: 'PRIMERA PARTE' },
      { type: 'done', truncada: true, motivo_corte: 'tiempo', usage: {}, pieza: PIEZA }];
  });
  await pedirSemana(page);
  await page.waitForTimeout(600);

  assert.equal(llamadas, 2, 'debería haber pedido la continuación sola');

  const bots = await page.evaluate(() =>
    [...document.querySelectorAll('#msgs .msg.bot')].length);
  assert.equal(bots, 1, 'la continuación va en la MISMA burbuja, no en una nueva');

  // El pedido de continuación no se pinta: el cliente no lo escribió.
  const usuarios = await page.evaluate(() =>
    [...document.querySelectorAll('#msgs .msg.user')].map((m) => m.innerText.trim()));
  assert.deepEqual(usuarios, ['/semana']);

  await page.click('text=Ver el texto acá');
  await page.waitForTimeout(200);
  const r = await respuesta(page);
  assert.match(r.texto, /PRIMERA PARTE SEGUNDA PARTE/);
  assert.deepEqual(errores, []);
  await browser.close();
});

test('la continuación manda el id de la pieza para no duplicarla', opciones, async () => {
  const cuerpos = [];
  const { browser, page } = await abrirApp((cuerpo) => {
    cuerpos.push(cuerpo);
    if (cuerpo.continua_pieza) {
      return [{ type: 'text', text: ' fin' }, { type: 'done', truncada: false, usage: {}, pieza: PIEZA }];
    }
    return [{ type: 'text', text: 'inicio' }, { type: 'done', truncada: true, usage: {}, pieza: PIEZA }];
  });
  await pedirSemana(page);
  await page.waitForTimeout(600);

  assert.equal(cuerpos[0].continua_pieza, undefined);
  assert.equal(cuerpos[1].continua_pieza, PIEZA.id,
    'sin esto la biblioteca queda con "Plan semanal (1 de 3)", "(2 de 3)"…');
  await browser.close();
});

test('no se pide la continuación para siempre', opciones, async () => {
  // Un modelo que nunca termina no puede generar pedidos infinitos.
  let llamadas = 0;
  const { browser, page } = await abrirApp(() => {
    llamadas++;
    return [{ type: 'text', text: 'y sigue… ' },
      { type: 'done', truncada: true, motivo_corte: 'tiempo', usage: {}, pieza: PIEZA }];
  });
  await pedirSemana(page);
  await page.waitForTimeout(1500);

  assert.ok(llamadas <= 4, `pidió ${llamadas} tramos: tiene que haber un tope`);
  const r = await respuesta(page);
  // Al llegar al tope queda el botón manual, no un silencio.
  assert.match(r.texto, /quedó incompleto|Continuar desde donde quedó/i);
  await browser.close();
});

// --- el reloj del cliente ---------------------------------------------------

test('un pedido colgado no espera para siempre', opciones, async () => {
  // `fetch` no tiene timeout: sin este reloj, una conexión que se cuelga deja el
  // indicador de "escribiendo…" girando indefinidamente y el cliente no sabe si
  // esperar, reintentar o avisar. Es la queja literal: "se trabó, no me respondió
  // más".
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage();

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.endsWith('/app')) return route.fulfill({ status: 200, contentType: 'text/html', body: HTML });
    if (url.includes('/api/auth/sesion')) {
      return json({ sesion: { email: 'a@x.com', nombre: 'A', perfil_cargado: true }, config: { precio: '59', moneda: 'USD' } });
    }
    if (url.includes('/api/chat')) return json({ mensajes: [] });
    // Tarda mucho en responder. Termina resolviendo —si no, el cierre del
    // navegador también queda colgado y el test cuelga la suite entera— pero
    // bastante después de que salte el reloj del cliente.
    if (url.includes('/api/synoma')) {
      await new Promise((r) => setTimeout(r, 4000));
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
    }
    if (url.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 404, body: '' });
  });

  await page.goto(`${ORIGEN}/app`);
  await page.waitForSelector('#view-dash.active');
  // Se acorta el reloj para no esperar 35 segundos en un test. Funciona porque las
  // constantes son `var`: quedan en window y se pueden pisar desde acá.
  await page.evaluate(() => { window.ESPERA_ARRANQUE = 1500; });
  await page.click('text=Mi semana de contenido');

  // Mientras espera, el contador tiene que moverse: es lo que distingue "está
  // pensando" de "se colgó".
  await page.waitForTimeout(1200);
  const esperando = await page.evaluate(() => document.getElementById('typing').textContent);
  assert.match(esperando, /\(\d+s\)/, `el contador no aparece: ${esperando}`);

  // Y al saltar el reloj tiene que salir un mensaje, no silencio.
  await page.waitForFunction(() => document.querySelectorAll('#msgs .msg.bot').length > 0, { timeout: 8000 });
  const r = await respuesta(page);
  assert.match(r.texto, /tardó demasiado/i);
  assert.ok(r.tieneBotonReintentar);
  await browser.close();
});

// --- errores del servidor que sí traen mensaje ------------------------------

test('un error del servidor se muestra con su mensaje, no en blanco', opciones, async () => {
  const browserYPage = await abrirApp(() => []);
  const { browser, page } = browserYPage;
  await page.unrouteAll();
  await page.route('**/api/synoma', (route) => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'sin_perfil', message: 'Primero cargá tu identidad.' }),
  }));
  await page.route('**/api/perfil', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ perfil: null }) }));

  await pedirSemana(page);
  const r = await respuesta(page);
  assert.match(r.texto, /Primero cargá tu identidad/);
  await browser.close();
});
