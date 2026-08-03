// Test de humo: se IMPORTAN y se EJECUTAN todos los endpoints.
//
// Por qué existe, en concreto: en este proyecto ya hubo un bug donde faltaba un
// import en _email.js. `node --check` pasaba —la sintaxis era válida— y los tests
// no tocaban esa rama, así que iba a explotar el día que se conectara el envío
// real, con clientes esperando. Verificar la sintaxis NO es verificar que el
// módulo corre.
//
// Después pasó lo mismo con una excepción no prevista en synoma.js: Netlify
// devolvía su propia página de error, que no es JSON, y el navegador mostraba
// "no se pudo contactar al motor" — indistinguible de un wifi caído. Dos rondas
// de diagnóstico a ciegas.
//
// Este archivo recorre todos los handlers y verifica lo mínimo indispensable:
// que carguen, que respondan un Response, y que ante cualquier entrada —incluida
// una que rompa la base— la respuesta sea JSON con un código legible. Ese
// contrato es lo que hace que un problema en producción se pueda diagnosticar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { usarSqlDePrueba } from '../netlify/functions/_db.js';

const DIR = new URL('../netlify/functions/', import.meta.url);
const ORIGIN = 'https://synoma.foundersbs.com';

// Los archivos que arrancan con _ son módulos internos, no endpoints.
const ENDPOINTS = readdirSync(DIR)
  .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
  .sort();

const INTERNOS = readdirSync(DIR)
  .filter((f) => f.startsWith('_') && f.endsWith('.js'))
  .sort();

function entorno() {
  process.env.DATABASE_URL = 'postgresql://prueba';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SYNOMA_ALLOWED_ORIGINS = '';
}

// Base que tira en TODA consulta. Es el caso interesante: un endpoint puede
// verse bien y romperse igual cuando la base contesta mal.
const baseRota = async () => { throw new Error('base caída de prueba'); };

test('todos los módulos internos se pueden importar de verdad', async () => {
  for (const f of INTERNOS) {
    const mod = await import(new URL(f, DIR));
    assert.ok(mod, `no se pudo importar ${f}`);
  }
  assert.ok(INTERNOS.length >= 10, `se esperaban más módulos, hay ${INTERNOS.length}`);
});

test('todos los endpoints exportan un handler y una ruta', async () => {
  for (const f of ENDPOINTS) {
    const mod = await import(new URL(f, DIR));
    assert.equal(typeof mod.default, 'function', `${f} no exporta un handler`);
    // purga.js es una función programada: lleva schedule en vez de path.
    const cfg = mod.config ?? {};
    assert.ok(cfg.path || cfg.schedule, `${f} no declara ni path ni schedule`);
  }
  assert.ok(ENDPOINTS.length >= 7, `se esperaban más endpoints, hay ${ENDPOINTS.length}`);
});

test('ninguna ruta se repite (dos funciones en el mismo path se pisan)', async () => {
  const vistas = new Map();
  for (const f of ENDPOINTS) {
    const mod = await import(new URL(f, DIR));
    const ruta = mod.config?.path;
    if (!ruta) continue;
    assert.ok(!vistas.has(ruta), `${f} y ${vistas.get(ruta)} declaran ${ruta}`);
    vistas.set(ruta, f);
  }
});

test('con la base caída, todos responden JSON con un código — nunca una excepción', async () => {
  entorno();

  for (const f of ENDPOINTS) {
    if (f === 'purga.js') continue;   // programada, no la llama un navegador
    usarSqlDePrueba(baseRota);
    const mod = await import(new URL(f, DIR) + '?t=' + Math.random());
    const ruta = mod.config.path;

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const init = { method, headers: { Origin: ORIGIN, Cookie: 'synoma_sesion=t' } };
      if (method !== 'GET') {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ email: 'a@b.com', codigo: '123456', mensaje: 'hola', contenido: 'x' });
      }

      let res;
      try {
        res = await mod.default(new Request(ORIGIN + ruta, init));
      } catch (e) {
        assert.fail(`${f} ${method} tiró una excepción en vez de responder: ${e.message}`);
      }

      assert.ok(res instanceof Response, `${f} ${method} no devolvió un Response`);

      // Lo importante: el cuerpo tiene que ser JSON legible. Si no lo es, el
      // navegador no puede mostrar ni el código ni el motivo, y el cliente ve un
      // error genérico que no sirve para nada.
      const texto = await res.text();
      if (res.status === 204) continue;
      let cuerpo;
      try { cuerpo = JSON.parse(texto); } catch {
        assert.fail(`${f} ${method} devolvió ${res.status} con un cuerpo que no es JSON: ${texto.slice(0, 120)}`);
      }
      assert.ok(cuerpo.error || cuerpo.ok || cuerpo.mensajes || cuerpo.piezas || cuerpo.plan,
        `${f} ${method} devolvió JSON sin código de error ni datos: ${texto.slice(0, 120)}`);
    }
  }
});

test('un endpoint que explota igual devuelve JSON con error_interno', async () => {
  entorno();
  // Se fuerza una excepción que ningún try/catch del handler prevé: una base que
  // devuelve algo con la forma equivocada en lugar de tirar.
  usarSqlDePrueba(async () => { throw { raro: true }; });

  const mod = await import(new URL('chat.js', DIR) + '?t=' + Math.random());
  const res = await mod.default(new Request(ORIGIN + '/api/chat', {
    headers: { Origin: ORIGIN, Cookie: 'synoma_sesion=t' },
  }));
  const cuerpo = await res.json();
  assert.ok(cuerpo.error, 'sin código de error no hay nada que diagnosticar');
});

test('ninguna respuesta filtra la clave de la API ni la URL de la base', async () => {
  process.env.DATABASE_URL = 'postgresql://usuario:CLAVE-SECRETA@host/base';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-NO-FILTRAR-ESTO';
  process.env.SYNOMA_ALLOWED_ORIGINS = '';

  for (const f of ENDPOINTS) {
    if (f === 'purga.js') continue;
    usarSqlDePrueba(baseRota);
    const mod = await import(new URL(f, DIR) + '?t=' + Math.random());
    const res = await mod.default(new Request(ORIGIN + mod.config.path, {
      method: 'GET', headers: { Origin: ORIGIN, Cookie: 'synoma_sesion=t' },
    }));
    const texto = await res.text();
    assert.ok(!texto.includes('NO-FILTRAR-ESTO'), `${f} filtró la API key`);
    assert.ok(!texto.includes('CLAVE-SECRETA'), `${f} filtró la contraseña de la base`);
  }
});
