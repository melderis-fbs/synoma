// Tests del plan semanal como calendario.
//
// El parseo depende de que el modelo respete el formato de la tabla, o sea que es
// la parte frágil del sistema. Estos tests son los que dicen cuánto desvío
// tolera antes de romperse, y —más importante— que cuando no puede parsear
// devuelva null en vez de un calendario a medias: media semana en la agenda del
// cliente es peor que ninguna.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usarSqlDePrueba } from '../netlify/functions/_db.js';
import { parsearPlan, fecharPiezas, generarIcs, generarCsv } from '../netlify/functions/_plan.js';

// Una respuesta como la que devuelve /semana de verdad: con preámbulo antes,
// nota después, markdown dentro de las celdas y tildes en los días.
const TABLA = `Antes de la tabla, un aviso corto.

| Día | Pilar | Formato | Dolor | Gancho | Punteo | Intención | Tiempo |
|---|---|---|---|---|---|---|---|
| Lun | Detrás del Sistema | Reel yapping | Desconfianza inicial | **"No vendo mentorías"** | 1) diez años emprendiendo 2) errores caros 3) no es teoría | Sin venta | 15 min |
| Mié | Sin Humo | Reel | Creen que publicar más vende más | *"Te dije que el algoritmo no es tu problema"* | a · b · c | educativa | 10 min |
| Vie | Mi Oferta | Carrusel | No sabe cuánto cuesta | "Esto cuesta lo que cuesta" | precio · garantía · cómo entrar | venta | 20 min |

Una nota final del modelo.`;

// --- parseo -----------------------------------------------------------------

test('se parsea la tabla aunque venga con texto antes y después', () => {
  const r = parsearPlan(TABLA);
  assert.equal(r.piezas.length, 3);
  assert.deepEqual(r.piezas.map((p) => p.dia), ['Lunes', 'Miércoles', 'Viernes']);
});

test('el markdown de las celdas se limpia', () => {
  const [lun] = parsearPlan(TABLA).piezas;
  // El gancho llega con asteriscos y comillas porque en el chat se lee mejor,
  // pero en un evento de calendario eso es ruido.
  assert.equal(lun.gancho, 'No vendo mentorías');
  assert.ok(!lun.gancho.includes('*'));
  assert.ok(!lun.gancho.includes('"'));
});

test('"Sin venta" NO se cuenta como venta', () => {
  // Buscar "vent" sin más marcaría estas piezas como de venta, o sea justo lo
  // contrario, y el calendario mostraría cinco piezas vendiendo.
  const r = parsearPlan(TABLA);
  assert.equal(r.piezas[0].intencion, 'educativa', '"Sin venta" es educativa');
  assert.equal(r.piezas[1].intencion, 'educativa');
  assert.equal(r.piezas[2].intencion, 'venta');
});

test('el punteo se parte en ideas, con numeritos o con puntos medios', () => {
  const r = parsearPlan(TABLA);
  assert.deepEqual(r.piezas[0].punteo, ['diez años emprendiendo', 'errores caros', 'no es teoría']);
  assert.deepEqual(r.piezas[1].punteo, ['a', 'b', 'c']);
});

test('los días se reconocen escritos de cualquier forma', () => {
  const variantes = ['Lun', 'lunes', 'LUNES', 'Lun 4/8'];
  for (const v of variantes) {
    const md = `| Día | Gancho |\n|---|---|\n| ${v} | algo |`;
    assert.equal(parsearPlan(md)?.piezas[0].dia, 'Lunes', `falló con ${v}`);
  }
  for (const [v, esperado] of [['Mié', 'Miércoles'], ['mie', 'Miércoles'],
    ['miercoles', 'Miércoles'], ['Sáb', 'Sábado'], ['sabado', 'Sábado']]) {
    const md = `| Día | Gancho |\n|---|---|\n| ${v} | algo |`;
    assert.equal(parsearPlan(md)?.piezas[0].dia, esperado, `falló con ${v}`);
  }
});

test('el encabezado se encuentra aunque no sea la primera fila con pipes', () => {
  const md = `| algo | raro | que | el modelo | escribió |

| Día | Pilar | Gancho |
|---|---|---|
| Mar | Valor | un gancho |`;
  assert.equal(parsearPlan(md).piezas.length, 1);
});

test('las columnas se mapean por nombre, no por posición', () => {
  // Si el modelo cambia el orden, cada dato tiene que seguir cayendo en su lugar.
  const md = `| Gancho | Día | Tiempo | Pilar |
|---|---|---|---|
| el gancho | Jue | 8 min | el pilar |`;
  const [p] = parsearPlan(md).piezas;
  assert.equal(p.gancho, 'el gancho');
  assert.equal(p.dia, 'Jueves');
  assert.equal(p.tiempo, '8 min');
  assert.equal(p.pilar, 'el pilar');
});

test('faltar columnas no rompe el parseo', () => {
  const md = `| Día | Gancho |\n|---|---|\n| Lun | solo esto |`;
  const [p] = parsearPlan(md).piezas;
  assert.equal(p.gancho, 'solo esto');
  assert.equal(p.pilar, undefined);
  assert.deepEqual(p.punteo, []);
});

test('las filas que no son piezas se descartan', () => {
  const md = `| Día | Gancho |
|:---|---:|
| Lun | una pieza |
| | |
| Total | 5 piezas |
| Mar | otra pieza |`;
  const r = parsearPlan(md);
  // "Total" no es un día, así que esa fila no entra al calendario.
  assert.equal(r.piezas.length, 2);
  assert.deepEqual(r.piezas.map((p) => p.dia), ['Lunes', 'Martes']);
});

test('sin tabla usable devuelve null y no un calendario a medias', () => {
  for (const malo of ['', null, 'Texto sin ninguna tabla.', '| solo | una | fila |',
    '| Otra | Cosa |\n|---|---|\n| a | b |']) {
    assert.equal(parsearPlan(malo), null, `debería devolver null: ${JSON.stringify(malo)}`);
  }
});

test('una tabla con encabezado pero sin filas válidas devuelve null', () => {
  const md = `| Día | Gancho |\n|---|---|\n| Total | 5 |`;
  assert.equal(parsearPlan(md), null);
});

// --- fechas ------------------------------------------------------------------

test('el lunes de un plan hecho un lunes es ese mismo día', () => {
  const lunes = new Date('2026-08-03T12:00:00Z');   // 3/8/2026 es lunes
  const [p] = fecharPiezas(parsearPlan(TABLA).piezas.slice(0, 1), lunes);
  assert.equal(p.fecha, '2026-08-03');
});

test('cada pieza cae en el próximo día de la semana que le toca', () => {
  const lunes = new Date('2026-08-03T12:00:00Z');
  const fechas = fecharPiezas(parsearPlan(TABLA).piezas, lunes).map((p) => p.fecha);
  assert.deepEqual(fechas, ['2026-08-03', '2026-08-05', '2026-08-07']);
});

test('un plan hecho un miércoles no manda el lunes al pasado', () => {
  // Si el lunes cayera antes de hoy, el evento aparecería en una fecha ya vencida.
  const miercoles = new Date('2026-08-05T12:00:00Z');
  const fechas = fecharPiezas(parsearPlan(TABLA).piezas, miercoles).map((p) => p.fecha);
  assert.deepEqual(fechas, ['2026-08-10', '2026-08-05', '2026-08-07']);
  for (const f of fechas) assert.ok(f >= '2026-08-05');
});

test('dos piezas el mismo día no se pisan', () => {
  const md = `| Día | Gancho |\n|---|---|\n| Lun | primera |\n| Lun | segunda |`;
  const fechas = fecharPiezas(parsearPlan(md).piezas, new Date('2026-08-03T12:00:00Z'))
    .map((p) => p.fecha);
  assert.deepEqual(fechas, ['2026-08-03', '2026-08-10']);
});

test('la fecha no se corre un día por la zona horaria', () => {
  // Un plan generado a las 23:30 no puede aparecer con la fecha del día anterior.
  const tarde = new Date('2026-08-03T23:30:00Z');
  const [p] = fecharPiezas(parsearPlan(TABLA).piezas.slice(0, 1), tarde);
  assert.equal(p.fecha, '2026-08-03');
});

// --- .ics --------------------------------------------------------------------

function ics() {
  const piezas = fecharPiezas(parsearPlan(TABLA).piezas, new Date('2026-08-03T12:00:00Z'));
  return generarIcs(piezas, { ahora: new Date('2026-08-03T12:00:00Z') });
}

test('el .ics tiene la estructura que piden los calendarios', () => {
  const t = ics();
  assert.match(t, /^BEGIN:VCALENDAR\r\n/);
  assert.match(t, /VERSION:2\.0/);
  assert.match(t, /END:VCALENDAR\r\n$/);
  assert.equal((t.match(/BEGIN:VEVENT/g) ?? []).length, 3);
  assert.equal((t.match(/END:VEVENT/g) ?? []).length, 3);
});

test('todas las líneas terminan en CRLF', () => {
  // El RFC 5545 lo exige. Con \n solo, Outlook descarta el archivo entero.
  for (const linea of ics().split('\r\n')) {
    assert.ok(!linea.includes('\n'), `línea con \\n suelto: ${linea}`);
  }
});

test('ninguna línea pasa de 75 caracteres', () => {
  // Sin plegar, una descripción larga hace que algunos calendarios ignoren el
  // evento sin avisar.
  for (const linea of ics().split('\r\n')) {
    assert.ok(linea.length <= 75, `línea de ${linea.length}: ${linea.slice(0, 90)}`);
  }
});

test('las continuaciones arrancan con un espacio', () => {
  const lineas = ics().split('\r\n');
  const desc = lineas.findIndex((l) => l.startsWith('DESCRIPTION:'));
  assert.ok(lineas[desc + 1].startsWith(' '), 'la línea plegada necesita el espacio');
});

test('las comas y los punto y coma van escapados', () => {
  const piezas = fecharPiezas(
    parsearPlan('| Día | Gancho |\n|---|---|\n| Lun | uno, dos; tres |').piezas,
    new Date('2026-08-03T12:00:00Z'));
  const t = generarIcs(piezas, { ahora: new Date('2026-08-03T12:00:00Z') });
  // Una coma sin escapar parte el campo en dos y el calendario lee otra cosa.
  assert.match(t, /uno\\, dos\\; tres/);
});

test('el evento es de día completo y termina al día siguiente', () => {
  const t = ics();
  assert.match(t, /DTSTART;VALUE=DATE:20260803/);
  // DTEND en un evento de día completo es exclusivo: sin el +1 el evento no se
  // muestra en Google Calendar.
  assert.match(t, /DTEND;VALUE=DATE:20260804/);
  assert.ok(!/DTSTART:.*T\d{6}/.test(t), 'no debería tener hora inventada');
});

test('el UID es estable, así reimportar no duplica los eventos', () => {
  assert.equal(ics(), ics());
  assert.match(ics(), /UID:synoma-20260803-0@foundersbs\.com/);
});

test('el fin de mes no genera una fecha imposible', () => {
  const md = '| Día | Gancho |\n|---|---|\n| Dom | cierre de mes |';
  const piezas = fecharPiezas(parsearPlan(md).piezas, new Date('2026-08-31T12:00:00Z'));
  assert.equal(piezas[0].fecha, '2026-09-06');
  assert.match(generarIcs(piezas, { ahora: new Date() }), /DTEND;VALUE=DATE:20260907/);
});

// --- .csv --------------------------------------------------------------------

test('el .csv arranca con el BOM para que Excel lea las tildes', () => {
  const t = generarCsv(fecharPiezas(parsearPlan(TABLA).piezas, new Date('2026-08-03T12:00:00Z')));
  assert.equal(t.charCodeAt(0), 0xFEFF, 'sin BOM, Excel en Windows muestra "Miércoles"');
  assert.match(t, /"Miércoles"/);
});

test('las comillas de adentro de una celda se duplican', () => {
  const md = '| Día | Gancho |\n|---|---|\n| Lun | dijo "esto" |';
  const t = generarCsv(fecharPiezas(parsearPlan(md).piezas, new Date('2026-08-03T12:00:00Z')));
  assert.match(t, /"dijo ""esto"""/);
});

test('una celda que arranca con = o - no se vuelve fórmula de Excel', () => {
  // Excel ejecuta una celda que empieza con = + - o @. Un gancho que arranca con
  // un guion es normal en este producto.
  const md = '| Día | Gancho |\n|---|---|\n| Lun | =SUM(A1:A9) |\n| Mar | -no hagas esto |';
  const t = generarCsv(fecharPiezas(parsearPlan(md).piezas, new Date('2026-08-03T12:00:00Z')));
  assert.match(t, /"'=SUM\(A1:A9\)"/);
  assert.match(t, /"'-no hagas esto"/);
});

test('el csv tiene una fila por pieza más el encabezado', () => {
  const t = generarCsv(fecharPiezas(parsearPlan(TABLA).piezas, new Date('2026-08-03T12:00:00Z')));
  assert.equal(t.trimEnd().split('\r\n').length, 4);
  assert.match(t, /"Publicada"/, 'una columna vacía para que la marque a mano');
});

// --- el endpoint -------------------------------------------------------------

const ORIGIN = 'https://synoma.foundersbs.com';
const UUID_OK = '11111111-2222-3333-4444-555555555555';

function db({ pieza = { id: UUID_OK, tipo: 'plan', titulo: 'Mi semana', contenido: TABLA, creado_en: '2026-08-03T12:00:00Z' } } = {}) {
  const sql = async (strings) => {
    const texto = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (texto.includes('FROM sesiones')) {
      return [{ id: 'cli-1', email: 'a@x.com', nombre: 'A', acceso: 'activo', origen_acceso: 'founders', sesion_id: 's-1' }];
    }
    if (texto.includes('FROM piezas')) return pieza ? [pieza] : [];
    return [];
  };
  return sql;
}

async function endpoint(base = db()) {
  process.env.DATABASE_URL = 'postgresql://prueba';
  process.env.SYNOMA_ALLOWED_ORIGINS = '';
  usarSqlDePrueba(base);
  const mod = await import('../netlify/functions/plan.js?t=' + Math.random());
  return mod.default;
}

const get = (query, cookie = 'synoma_sesion=t') => new Request(`${ORIGIN}/api/plan${query}`, {
  headers: cookie ? { Origin: ORIGIN, Cookie: cookie } : { Origin: ORIGIN },
});

test('el calendario en JSON trae las piezas ya fechadas', async () => {
  const handler = await endpoint();
  const res = await handler(get(`?id=${UUID_OK}`));
  assert.equal(res.status, 200);
  const { plan } = await res.json();
  assert.equal(plan.piezas.length, 3);
  assert.equal(plan.piezas[0].fecha, '2026-08-03');
});

test('las fechas salen del día en que se generó el plan, no de hoy', async () => {
  // Si el cliente abre en septiembre un plan de agosto, tiene que ver agosto.
  const handler = await endpoint();
  const { plan } = await (await handler(get(`?id=${UUID_OK}`))).json();
  assert.ok(plan.piezas.every((p) => p.fecha.startsWith('2026-08')));
});

test('el .ics se descarga como archivo, no se abre como texto', async () => {
  const handler = await endpoint();
  const res = await handler(get(`?id=${UUID_OK}&formato=ics`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  // attachment: con inline, Safari en iPhone lo muestra como texto en vez de
  // ofrecer agregarlo al calendario.
  assert.match(res.headers.get('content-disposition'), /attachment; filename="synoma-semana-2026-08-03\.ics"/);
  assert.match(await res.text(), /BEGIN:VCALENDAR/);
});

test('el .csv se descarga con su nombre', async () => {
  const handler = await endpoint();
  const res = await handler(get(`?id=${UUID_OK}&formato=csv`));
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /\.csv"/);
});

test('sin sesión no se descarga el plan de nadie', async () => {
  const handler = await endpoint();
  const res = await handler(get(`?id=${UUID_OK}`, null));
  assert.equal(res.status, 401);
});

test('un id que no es UUID se rechaza con 400', async () => {
  const handler = await endpoint();
  for (const id of ['1', 'abc', '', 'DROP TABLE piezas']) {
    assert.equal((await handler(get('?id=' + encodeURIComponent(id)))).status, 400);
  }
});

test('una pieza que no es del cliente devuelve 404', async () => {
  const handler = await endpoint(db({ pieza: null }));
  assert.equal((await handler(get(`?id=${UUID_OK}`))).status, 404);
});

test('un plan sin tabla devuelve 422 con una explicación útil', async () => {
  const handler = await endpoint(db({
    pieza: { id: UUID_OK, tipo: 'plan', titulo: 'x', contenido: 'texto libre sin tabla', creado_en: '2026-08-03T12:00:00Z' },
  }));
  const res = await handler(get(`?id=${UUID_OK}`));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error, 'sin_tabla');
  // El mensaje tiene que decirle qué hacer, no solo que falló.
  assert.match(body.message, /\/semana/);
});

test('un origen ajeno no puede bajarse el plan', async () => {
  const handler = await endpoint();
  const req = new Request(`${ORIGIN}/api/plan?id=${UUID_OK}`, {
    headers: { Origin: 'https://sitio-ajeno.com', Cookie: 'synoma_sesion=t' },
  });
  assert.equal((await handler(req)).status, 403);
});

test('POST no está permitido', async () => {
  const handler = await endpoint();
  const req = new Request(`${ORIGIN}/api/plan?id=${UUID_OK}`, {
    method: 'POST', headers: { Origin: ORIGIN, Cookie: 'synoma_sesion=t' },
  });
  assert.equal((await handler(req)).status, 405);
});
