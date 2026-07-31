// Tests del login. Es la parte sensible: si el código de 6 dígitos se puede
// adivinar o reutilizar, cualquiera entra a la cuenta de un cliente.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { usarSqlDePrueba, normalizarEmail, emailPlausible } from '../netlify/functions/_db.js';
import {
  generarCodigo, verificarCodigo, guardarCodigo, cookieDeSesion, cookieBorrada,
  clienteDeSesion, LIMITES,
} from '../netlify/functions/_auth.js';

const hash = (v) => createHash('sha256').update(String(v)).digest('hex');

// Base falsa que devuelve una fila de codigos_acceso configurable y registra
// las escrituras, para poder afirmar que se marcó como usado o que se contó el
// intento fallido.
function fakeDb({ codigo = null, sesion = undefined } = {}) {
  const escrituras = [];
  const sql = async (strings) => {
    const texto = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (texto.includes('FROM codigos_acceso')) return codigo ? [codigo] : [];
    if (texto.includes('FROM sesiones')) return sesion ? [sesion] : [];
    if (texto.includes('count(*)')) return [{ n: 0 }];
    escrituras.push(texto);
    return [];
  };
  sql.escrituras = escrituras;
  sql.marcoUsado = () => escrituras.some((e) => e.includes('usado_en = now()'));
  sql.contoIntento = () => escrituras.some((e) => e.includes('intentos = intentos + 1'));
  return sql;
}

const enMinutos = (m) => new Date(Date.now() + m * 60_000).toISOString();

function filaCodigo(codigo, extra = {}) {
  return {
    id: 'c-1',
    codigo_hash: hash(codigo),
    intentos: 0,
    expira_en: enMinutos(10),
    usado_en: null,
    ...extra,
  };
}

// --- generación -------------------------------------------------------------

test('el código son siempre 6 dígitos, incluso con ceros adelante', () => {
  for (let i = 0; i < 500; i++) {
    const c = generarCodigo();
    assert.match(c, /^\d{6}$/, `código inválido: ${c}`);
  }
});

test('los códigos no se repiten de forma evidente', () => {
  const vistos = new Set(Array.from({ length: 300 }, () => generarCodigo()));
  // Con 300 tiradas sobre un millón de valores, repetir mucho indicaría que el
  // generador no es aleatorio de verdad.
  assert.ok(vistos.size > 290, `demasiadas repeticiones: ${vistos.size}/300`);
});

// --- verificación -----------------------------------------------------------

test('el código correcto entra y queda marcado como usado', async () => {
  const db = fakeDb({ codigo: filaCodigo('123456') });
  usarSqlDePrueba(db);
  const r = await verificarCodigo('ana@ejemplo.com', '123456');
  assert.equal(r.ok, true);
  assert.ok(db.marcoUsado(), 'sin esto el código serviría más de una vez');
});

test('el mismo código no sirve dos veces', async () => {
  usarSqlDePrueba(fakeDb({ codigo: filaCodigo('123456', { usado_en: new Date().toISOString() }) }));
  const r = await verificarCodigo('ana@ejemplo.com', '123456');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'usado');
});

test('un código vencido no entra', async () => {
  usarSqlDePrueba(fakeDb({ codigo: filaCodigo('123456', { expira_en: enMinutos(-1) }) }));
  const r = await verificarCodigo('ana@ejemplo.com', '123456');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'expirado');
});

test('un código incorrecto cuenta el intento y avisa cuántos quedan', async () => {
  const db = fakeDb({ codigo: filaCodigo('123456', { intentos: 1 }) });
  usarSqlDePrueba(db);
  const r = await verificarCodigo('ana@ejemplo.com', '999999');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'incorrecto');
  assert.equal(r.restantes, LIMITES.MAX_INTENTOS - 2);
  assert.ok(db.contoIntento(), 'sin contar intentos, 6 dígitos se prueban por fuerza bruta');
});

test('agotados los intentos deja de aceptar ese código', async () => {
  const db = fakeDb({ codigo: filaCodigo('123456', { intentos: LIMITES.MAX_INTENTOS }) });
  usarSqlDePrueba(db);
  // Incluso con el código CORRECTO: si no, bastaría con seguir probando.
  const r = await verificarCodigo('ana@ejemplo.com', '123456');
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'demasiados_intentos');
});

test('sin código pendiente se distingue de código incorrecto', async () => {
  usarSqlDePrueba(fakeDb({ codigo: null }));
  const r = await verificarCodigo('nadie@ejemplo.com', '123456');
  assert.equal(r.motivo, 'sin_codigo');
});

test('un código que no son 6 dígitos se rechaza antes de tocar la base', async () => {
  usarSqlDePrueba(() => { throw new Error('no debería consultarse'); });
  for (const malo of ['12345', '1234567', 'abcdef', '', null]) {
    const r = await verificarCodigo('ana@ejemplo.com', malo);
    assert.equal(r.motivo, 'formato', `debería rechazar: ${JSON.stringify(malo)}`);
  }
});

test('el código se acepta con espacios o guiones intercalados', async () => {
  usarSqlDePrueba(fakeDb({ codigo: filaCodigo('123456') }));
  // Un cliente que copia y pega del mail puede arrastrar separadores.
  const r = await verificarCodigo('ana@ejemplo.com', '123 456');
  assert.equal(r.ok, true);
});

// --- cookies ----------------------------------------------------------------

test('la cookie de sesión tiene las tres protecciones', () => {
  const c = cookieDeSesion('token-abc');
  assert.match(c, /HttpOnly/, 'sin HttpOnly el JavaScript de la página la puede leer');
  assert.match(c, /Secure/, 'sin Secure viaja por HTTP en claro');
  assert.match(c, /SameSite=Lax/);
  // Strict rompería el flujo previsto: entrar desde el portal de GHL o Skool.
  assert.ok(!/SameSite=Strict/.test(c));
});

test('la cookie de salida vence de inmediato', () => {
  assert.match(cookieBorrada(), /Max-Age=0/);
});

// --- sesión -----------------------------------------------------------------

function pedidoCon(cookie) {
  return new Request('https://synoma.foundersbs.com/api/perfil', {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

test('sin cookie no hay cliente', async () => {
  usarSqlDePrueba(fakeDb());
  assert.equal(await clienteDeSesion(pedidoCon(null)), null);
});

test('una cookie que no está en la base no da acceso', async () => {
  usarSqlDePrueba(fakeDb({ sesion: null }));
  assert.equal(await clienteDeSesion(pedidoCon('synoma_sesion=inventado')), null);
});

test('la sesión de un cliente suspendido se marca, no se acepta en silencio', async () => {
  usarSqlDePrueba(fakeDb({
    sesion: { id: 'c1', email: 'ex@x.com', nombre: null, acceso: 'suspendido', origen_acceso: 'founders', sesion_id: 's1' },
  }));
  const cliente = await clienteDeSesion(pedidoCon('synoma_sesion=t'));
  assert.equal(cliente.suspendido, true);
});

test('se lee la cookie correcta cuando hay varias', async () => {
  usarSqlDePrueba(fakeDb({
    sesion: { id: 'c1', email: 'ana@x.com', nombre: 'Ana', acceso: 'activo', origen_acceso: 'founders', sesion_id: 's1' },
  }));
  const cliente = await clienteDeSesion(pedidoCon('otra=1; synoma_sesion=t; tercera=3'));
  assert.equal(cliente.email, 'ana@x.com');
});

// --- normalización del email -----------------------------------------------

test('el email se normaliza igual siempre (si no, el perfil se parte en dos)', () => {
  const esperado = 'ana@ejemplo.com';
  for (const entrada of ['ana@ejemplo.com', 'Ana@Ejemplo.com', '  ANA@EJEMPLO.COM  ', 'ana@ejemplo.com​']) {
    assert.equal(normalizarEmail(entrada), esperado, `falló con ${JSON.stringify(entrada)}`);
  }
});

test('no se descartan puntos ni el signo +', () => {
  // En Gmail son equivalentes, pero en otros proveedores no: descartarlos haría
  // que dos personas distintas cayeran en la misma cuenta.
  assert.notEqual(normalizarEmail('a.na@ejemplo.com'), normalizarEmail('ana@ejemplo.com'));
  assert.notEqual(normalizarEmail('ana+x@ejemplo.com'), normalizarEmail('ana@ejemplo.com'));
});

test('la validación de email descarta basura pero acepta direcciones raras válidas', () => {
  for (const bueno of ['ana@ejemplo.com', 'a@b.co', 'ana.paula+founders@sub.ejemplo.com.ar']) {
    assert.ok(emailPlausible(bueno), `debería aceptar: ${bueno}`);
  }
  for (const malo of ['ana', 'ana@', '@ejemplo.com', 'ana@ejemplo', 'ana ejemplo.com', '']) {
    assert.ok(!emailPlausible(malo), `debería rechazar: ${JSON.stringify(malo)}`);
  }
});
