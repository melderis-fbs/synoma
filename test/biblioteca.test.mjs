// Tests de la biblioteca de contenidos.
//
// Dos cosas se protegen acá. Una es funcional: que lo que Synoma produce no se
// pierda. La otra es de aislamiento: todas las consultas tienen que filtrar por
// cliente_id, porque un UPDATE o un DELETE sin ese filtro le toca la biblioteca
// a otra persona y el cliente no tiene forma de darse cuenta.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usarSqlDePrueba } from '../netlify/functions/_db.js';
import {
  clasificar, titularPieza, guardarPieza, guardarSiEsPieza, listarPiezas,
  cambiarEstado, borrarPieza, resumenParaRacha, bloqueDeRacha, ESTADOS, ETIQUETAS,
} from '../netlify/functions/_biblioteca.js';

function fakeDb({ filas = [] } = {}) {
  const hechas = [];
  const sql = async (strings, ...valores) => {
    const texto = Array.isArray(strings) ? strings.join('?') : String(strings);
    hechas.push({ texto, valores });
    if (texto.includes('INTO piezas')) {
      return [{ id: 'p-1', tipo: valores[1], titulo: valores[2], estado: 'nueva', creado_en: 'hoy' }];
    }
    if (texto.includes('UPDATE piezas')) return filas.length ? filas : [{ id: 'p-1', estado: valores[0], publicado_en: null }];
    if (texto.includes('DELETE FROM piezas')) return filas;
    return filas;
  };
  sql.hechas = hechas;
  sql.con = (aguja) => hechas.filter((h) => h.texto.includes(aguja));
  return sql;
}

// --- qué se guarda solo y qué no --------------------------------------------

test('los comandos que producen contenido publicable se clasifican', () => {
  const esperado = {
    '/semana': 'plan', '/idea': 'idea', '/guion': 'guion', '/gancho': 'gancho',
    '/historias': 'historia', '/venta': 'venta', '/post': 'post',
    '/repurpose': 'reciclado', '/revisar': 'revision',
  };
  for (const [cmd, tipo] of Object.entries(esperado)) {
    assert.equal(clasificar(cmd)?.tipo, tipo, `${cmd} debería guardarse como ${tipo}`);
  }
});

test('los comandos de fundación y de repaso NO se guardan como piezas', () => {
  // /fundacion, /pilares, /persona, /hottakes y /banco son identidad y ya tienen
  // su lugar en el perfil. /racha y /objecion no son contenido publicable.
  // Guardarlos llenaría la grilla de cosas que el cliente no va a publicar.
  for (const cmd of ['/fundacion', '/pilares', '/persona', '/hottakes', '/banco', '/racha', '/objecion']) {
    assert.equal(clasificar(cmd), null, `${cmd} no debería ir a la biblioteca`);
  }
});

test('un mensaje escrito a mano no se guarda solo', () => {
  for (const t of ['hola', 'necesito ayuda con /guion', '', null, '  ']) {
    assert.equal(clasificar(t), null);
  }
});

test('el comando se reconoce con el argumento pegado y sin importar mayúsculas', () => {
  const c = clasificar('/GUION cómo elegir un nutricionista');
  assert.equal(c.tipo, 'guion');
  assert.equal(c.comando, '/guion');
  assert.equal(c.argumento, 'cómo elegir un nutricionista');
});

test('un comando parecido no se confunde con uno real', () => {
  // Sin cortar en el espacio, "/semanal" entraría como "/semana".
  assert.equal(clasificar('/semanal'), null);
  assert.equal(clasificar('/guioncito'), null);
});

// --- el título de la grilla -------------------------------------------------

test('el argumento del comando es el título', () => {
  assert.equal(
    titularPieza({ argumento: 'cómo elegir un nutricionista', respuesta: 'GANCHO: ...', tipo: 'guion' }),
    'cómo elegir un nutricionista');
});

test('sin argumento, el título sale de la primera línea con texto', () => {
  const t = titularPieza({
    argumento: '',
    respuesta: '---\n\n**## |**\n\nTu plan de la semana del 3 al 9\n\nLunes…',
    tipo: 'plan',
  });
  // Sin saltear las líneas decorativas, la mitad de los títulos serían "---".
  assert.equal(t, 'Tu plan de la semana del 3 al 9');
});

test('si no hay de dónde sacar título se usa el nombre del tipo', () => {
  assert.equal(titularPieza({ argumento: '', respuesta: '---\n***\n', tipo: 'plan' }), 'Plan semanal');
  assert.equal(titularPieza({ argumento: '', respuesta: '', tipo: 'guion' }), 'Guion');
});

test('el título se recorta y no arrastra el markdown', () => {
  const t = titularPieza({ argumento: '**' + 'a'.repeat(300) + '**', respuesta: '', tipo: 'post' });
  assert.ok(t.length <= 120);
  assert.ok(!t.includes('*'));
});

// --- guardar -----------------------------------------------------------------

test('la pieza se guarda con su tipo y su título', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  const p = await guardarSiEsPieza('cli-1', '/guion arrancar un negocio', 'GANCHO: nadie te dice esto…');

  const ins = db.con('INTO piezas')[0];
  assert.deepEqual(ins.valores,
    ['cli-1', 'guion', 'arrancar un negocio', 'GANCHO: nadie te dice esto…', '/guion']);
  assert.equal(p.tipo, 'guion');
});

test('una respuesta vacía no crea una pieza fantasma en la grilla', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  assert.equal(await guardarSiEsPieza('cli-1', '/guion x', '   '), null);
  assert.equal(db.con('INTO piezas').length, 0);
});

test('un tipo inventado cae en "otro" en vez de romper el CHECK de la tabla', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await guardarPieza('cli-1', { tipo: 'inventado', titulo: 't', contenido: 'c' });
  assert.equal(db.con('INTO piezas')[0].valores[1], 'otro');
});

test('un contenido gigante se recorta antes de guardarse', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await guardarPieza('cli-1', { tipo: 'post', titulo: 't', contenido: 'x'.repeat(90000) });
  assert.equal(db.con('INTO piezas')[0].valores[3].length, 40000);
});

// --- leer --------------------------------------------------------------------

test('la grilla se pide solo con las piezas del cliente', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await listarPiezas('cli-1');
  const q = db.con('FROM piezas')[0];
  assert.ok(q.texto.includes('cliente_id'), 'sin esto se vería la biblioteca de otro');
  assert.ok(q.valores.includes('cli-1'));
});

test('los filtros van como parámetros, no concatenados en el SQL', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await listarPiezas('cli-1', { estado: 'nueva', tipo: 'guion' });
  const q = db.con('FROM piezas')[0];
  // Armar el WHERE con texto es cómo se escriben las inyecciones. Si el filtro
  // apareciera dentro del SQL en vez de en los valores, este test falla.
  assert.ok(!q.texto.includes('nueva'));
  assert.ok(q.valores.includes('nueva'));
  assert.ok(q.valores.includes('guion'));
});

test('el límite de la grilla se acota aunque llegue un número absurdo', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await listarPiezas('cli-1', { limite: 999999 });
  assert.ok(db.con('FROM piezas')[0].valores.some((v) => v === 500));
});

// --- cambiar el estado -------------------------------------------------------

test('el estado se cambia solo dentro de la biblioteca del cliente', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await cambiarEstado('cli-1', 'p-9', 'publicada');
  const q = db.con('UPDATE piezas')[0];
  assert.ok(q.texto.includes('cliente_id'), 'sin esto se le cambia el estado a una pieza ajena');
  assert.ok(q.valores.includes('cli-1'));
  assert.ok(q.valores.includes('p-9'));
});

test('un estado inventado se rechaza sin tocar la base', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  assert.equal(await cambiarEstado('cli-1', 'p-1', 'borracha'), null);
  assert.equal(db.con('UPDATE piezas').length, 0);
});

test('publicar pone la fecha, y despublicar la limpia', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await cambiarEstado('cli-1', 'p-1', 'publicada');
  const q = db.con('UPDATE piezas')[0].texto;
  // Si la fecha quedara puesta al volver atrás, el panel diría que publicó algo
  // que en realidad despublicó.
  assert.match(q, /publicado_en = CASE/);
  assert.match(q, /ELSE NULL/);
});

test('los estados posibles son los cuatro que entiende la tabla', () => {
  assert.deepEqual(ESTADOS, ['nueva', 'grabada', 'publicada', 'archivada']);
});

// --- borrar ------------------------------------------------------------------

test('borrar filtra por cliente y avisa si no existía', async () => {
  usarSqlDePrueba(fakeDb({ filas: [] }));
  assert.equal(await borrarPieza('cli-1', 'p-1'), false);

  const db = fakeDb({ filas: [{ id: 'p-1' }] });
  usarSqlDePrueba(db);
  assert.equal(await borrarPieza('cli-1', 'p-1'), true);
  assert.ok(db.con('DELETE FROM piezas')[0].texto.includes('cliente_id'));
});

// --- el bloque de /racha ----------------------------------------------------

test('el resumen de /racha se pide filtrado por cliente y por fecha', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await resumenParaRacha('cli-1');
  const q = db.con('FROM piezas')[0];
  assert.ok(q.texto.includes('cliente_id'));
  assert.ok(q.texto.includes('INTERVAL'), 'traer la biblioteca entera infla el prompt sin necesidad');
});

test('el resumen NO manda el contenido de las piezas al prompt', async () => {
  const db = fakeDb();
  usarSqlDePrueba(db);
  await resumenParaRacha('cli-1');
  const q = db.con('FROM piezas')[0].texto;
  // Mandar el texto completo de 20 piezas costaría más que toda la respuesta.
  assert.ok(!/\bcontenido\b/.test(q), 'el repaso se hace con títulos y estados');
});

test('el bloque de /racha resume estados y no inventa cuando está vacío', () => {
  const vacio = bloqueDeRacha([]);
  assert.match(vacio, /vacía/);
  assert.match(vacio, /No inventes/);

  const con = bloqueDeRacha([
    { tipo: 'guion', titulo: 'nutricionista', estado: 'publicada', creado_en: '2026-07-01T10:00:00Z', publicado_en: '2026-07-03T10:00:00Z' },
    { tipo: 'post', titulo: 'objeción del precio', estado: 'nueva', creado_en: '2026-07-05T10:00:00Z', publicado_en: null },
  ]);
  assert.match(con, /publicadas 1/);
  assert.match(con, /sin grabar todavía 1/);
  assert.match(con, /\[publicada\] Guion — nutricionista/);
  assert.match(con, /2026-07-03/);
  assert.ok(!con.includes('undefined'));
  assert.ok(!con.includes('null'));
});

test('cada tipo tiene un nombre legible para la grilla', () => {
  for (const tipo of Object.values({
    plan: 'plan', idea: 'idea', guion: 'guion', gancho: 'gancho', historia: 'historia',
    venta: 'venta', post: 'post', reciclado: 'reciclado', revision: 'revision', otro: 'otro',
  })) {
    assert.ok(ETIQUETAS[tipo], `falta la etiqueta de ${tipo}`);
  }
});

// --- el endpoint -------------------------------------------------------------

const ORIGIN = 'https://synoma.foundersbs.com';
const URL_FN = `${ORIGIN}/api/biblioteca`;
const UUID_OK = '11111111-2222-3333-4444-555555555555';

function dbConSesion({ suspendido = false } = {}) {
  const base = fakeDb({ filas: [{ id: 'p-1', estado: 'nueva', publicado_en: null }] });
  const sql = async (strings, ...v) => {
    const texto = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (texto.includes('FROM sesiones')) {
      return [{
        id: 'cli-1', email: 'ana@x.com', nombre: 'Ana',
        acceso: suspendido ? 'suspendido' : 'activo', origen_acceso: 'founders', sesion_id: 's-1',
      }];
    }
    return base(strings, ...v);
  };
  sql.con = base.con;
  sql.hechas = base.hechas;
  return sql;
}

async function endpoint(db = dbConSesion()) {
  process.env.DATABASE_URL = 'postgresql://prueba';
  process.env.SYNOMA_ALLOWED_ORIGINS = '';
  usarSqlDePrueba(db);
  const mod = await import('../netlify/functions/biblioteca.js?t=' + Math.random());
  return mod.default;
}

function pedido(metodo, { cuerpo = null, query = '', cookie = 'synoma_sesion=t' } = {}) {
  const headers = { Origin: ORIGIN };
  if (cuerpo) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return new Request(URL_FN + query, {
    method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
}

test('sin sesión no se abre la biblioteca de nadie', async () => {
  const handler = await endpoint();
  const res = await handler(pedido('GET', { cookie: null }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'sin_sesion');
});

test('a quien se le terminó el acceso se le ofrece renovar', async () => {
  const handler = await endpoint(dbConSesion({ suspendido: true }));
  const res = await handler(pedido('GET'));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'acceso_terminado');
  assert.ok(body.config.precio);
});

test('un origen ajeno no puede tocar la biblioteca', async () => {
  const handler = await endpoint();
  const req = new Request(URL_FN, {
    method: 'GET', headers: { Origin: 'https://sitio-ajeno.com', Cookie: 'synoma_sesion=t' },
  });
  assert.equal((await handler(req)).status, 403);
});

test('un id que no es UUID se rechaza sin llegar a la base', async () => {
  // Postgres contesta un UUID mal formado con un error de sintaxis, que llegaría
  // al cliente como "la base falló" cuando el pedido estaba mal armado.
  const db = dbConSesion();
  const handler = await endpoint(db);
  for (const id of ['1', 'DROP TABLE piezas', '', '../../etc']) {
    const res = await handler(pedido('DELETE', { query: '?id=' + encodeURIComponent(id) }));
    assert.equal(res.status, 400, `debería rechazar el id ${JSON.stringify(id)}`);
  }
  assert.equal(db.con('DELETE FROM piezas').length, 0);
});

test('un estado inventado se rechaza con 400, no con un 500 de la base', async () => {
  const handler = await endpoint();
  const res = await handler(pedido('PATCH', { cuerpo: { id: UUID_OK, estado: 'borracha' } }));
  assert.equal(res.status, 400);
});

test('un filtro inventado se ignora en vez de llegar a la consulta', async () => {
  const db = dbConSesion();
  const handler = await endpoint(db);
  await handler(pedido('GET', { query: '?estado=inventado&tipo=inventado' }));
  const q = db.con('FROM piezas')[0];
  assert.ok(!q.valores.includes('inventado'));
});

test('guardar a mano sin contenido devuelve 400', async () => {
  const handler = await endpoint();
  const res = await handler(pedido('POST', { cuerpo: { contenido: '   ' } }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'sin_contenido');
});

test('guardar a mano funciona y devuelve la pieza', async () => {
  const handler = await endpoint();
  const res = await handler(pedido('POST', { cuerpo: { contenido: 'un texto que me gustó' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.pieza.tipo, 'otro');
});

test('un método no soportado devuelve 405 y OPTIONS 204', async () => {
  const handler = await endpoint();
  assert.equal((await handler(pedido('PUT'))).status, 405);
  assert.equal((await handler(pedido('OPTIONS'))).status, 204);
});

// --- el esquema --------------------------------------------------------------

test('las piezas no se purgan con el chat', async () => {
  // El chat es andamiaje y se borra a los 90 días. Las piezas son el activo del
  // cliente: si la purga las tocara, perdería su contenido sin haberlo pedido.
  const { readFileSync } = await import('node:fs');
  const purga = readFileSync(new URL('../netlify/functions/purga.js', import.meta.url), 'utf8');
  assert.ok(!/DELETE FROM piezas/i.test(purga), 'la purga no puede tocar la biblioteca');
});
