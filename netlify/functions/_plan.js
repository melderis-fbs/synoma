// Synoma Founders — el plan semanal como calendario
//
// /semana devuelve una tabla de markdown. Está bien para leer en el chat, pero
// como plan de trabajo es incómoda: no se puede llevar al teléfono, no entra en
// la agenda y en el celular se lee de costado.
//
// Acá se convierte esa tabla en datos, y de los datos salen tres cosas: la vista
// de calendario de la app, un .ics que se importa a Google Calendar o al iPhone,
// y un .csv que abre en Excel.
//
// Por qué el parseo vive en el servidor y no en el navegador: es la parte
// frágil (depende de que el modelo respete el formato) y así se puede testear.
//
// Las fechas NO se leen de la tabla: se calculan a partir del día de la semana
// que puso el modelo y de cuándo se generó el plan. Los modelos de lenguaje son
// malos con la aritmética de fechas, y una fecha mal calculada en un archivo que
// se importa a la agenda es peor que no tener el archivo.

const DIAS = [
  { claves: ['dom', 'domingo'], indice: 0, nombre: 'Domingo' },
  { claves: ['lun', 'lunes'], indice: 1, nombre: 'Lunes' },
  { claves: ['mar', 'martes'], indice: 2, nombre: 'Martes' },
  { claves: ['mie', 'mié', 'miercoles', 'miércoles'], indice: 3, nombre: 'Miércoles' },
  { claves: ['jue', 'jueves'], indice: 4, nombre: 'Jueves' },
  { claves: ['vie', 'viernes'], indice: 5, nombre: 'Viernes' },
  { claves: ['sab', 'sáb', 'sabado', 'sábado'], indice: 6, nombre: 'Sábado' },
];

// Encabezado de la tabla → clave del objeto. Se comparan sin tildes ni
// mayúsculas, así que "Día" y "DIA" caen en el mismo lugar.
const COLUMNAS = {
  dia: 'dia',
  pilar: 'pilar',
  formato: 'formato',
  dolor: 'dolor',
  gancho: 'gancho',
  punteo: 'punteo',
  intencion: 'intencion',
  tiempo: 'tiempo',
};

const sinTildes = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().trim();

// ---------------------------------------------------------------------------
// Parseo
// ---------------------------------------------------------------------------

// Devuelve { piezas: [...], columnas: [...] } o null si no hay una tabla usable.
// Nunca tira: si el modelo se salió del formato, la app muestra el texto plano y
// listo. Un plan que no se puede convertir a calendario sigue siendo un plan.
export function parsearPlan(markdown) {
  const filas = String(markdown ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map(celdas);

  if (filas.length < 2) return null;

  // El encabezado es la primera fila que tenga a la vez un "día" y un "gancho".
  // Buscarlo así (y no asumir que es la fila 0) tolera que el modelo escriba una
  // línea con pipes antes de la tabla.
  const iCab = filas.findIndex((f) => {
    const n = f.map(sinTildes);
    return n.some((c) => c.startsWith('dia')) && n.some((c) => c.includes('gancho'));
  });
  if (iCab === -1) return null;

  const cabecera = filas[iCab].map(sinTildes);
  const mapa = cabecera.map((c) => {
    for (const [aguja, clave] of Object.entries(COLUMNAS)) {
      if (c.startsWith(aguja) || c.includes(aguja)) return clave;
    }
    return null;
  });

  const piezas = [];
  for (const fila of filas.slice(iCab + 1)) {
    if (esSeparador(fila)) continue;

    const p = {};
    fila.forEach((valor, i) => {
      const clave = mapa[i];
      if (clave) p[clave] = limpiarCelda(valor);
    });

    const dia = reconocerDia(p.dia);
    // Sin día no hay lugar en el calendario, y una fila sin gancho ni formato es
    // basura de formato, no una pieza.
    if (!dia) continue;
    if (!p.gancho && !p.formato) continue;

    piezas.push({
      ...p,
      dia: dia.nombre,
      dia_corto: dia.nombre.slice(0, 3),
      dia_indice: dia.indice,
      intencion: normalizarIntencion(p.intencion),
      punteo: partirPunteo(p.punteo),
    });
  }

  return piezas.length ? { piezas } : null;
}

function celdas(linea) {
  return linea
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const esSeparador = (fila) => fila.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

// Se saca el markdown de adentro de la celda: el gancho llega con asteriscos y
// comillas porque en el chat se lee mejor así, pero en un .ics eso es ruido.
function limpiarCelda(v) {
  const texto = String(v ?? '')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Las comillas se sacan SOLO si envuelven toda la celda. Sacarlas de a una
  // punta dejaba `dijo "esto"` como `dijo "esto`, o sea una comilla sin cerrar
  // en el título del evento del calendario.
  return /^["“”'‘’].*["“”'‘’]$/.test(texto) && texto.length > 1
    ? texto.slice(1, -1).trim()
    : texto;
}

function reconocerDia(valor) {
  const v = sinTildes(valor);
  if (!v) return null;
  // Se compara por prefijo para tolerar "Lun 4/8" si el modelo agrega la fecha
  // igual, o "lunes".
  for (const d of DIAS) {
    if (d.claves.some((k) => v.startsWith(sinTildes(k)))) return d;
  }
  return null;
}

function normalizarIntencion(v) {
  const n = sinTildes(v);
  if (!n) return 'educativa';
  // El orden importa: el prompt pide "educativa" o "venta", pero el modelo a
  // veces escribe "sin venta" o "no venta". Buscar "vent" sin más marcaría esas
  // piezas como de venta, o sea justo lo contrario, y el calendario mostraría
  // cinco piezas vendiendo cuando en realidad son tres educativas.
  if (/^(sin|no|nada)\b/.test(n) || /\bsin (intencion de )?vent/.test(n)) return 'educativa';
  return /vent|compr|ofert/.test(n) ? 'venta' : 'educativa';
}

function partirPunteo(v) {
  const texto = String(v ?? '').trim();
  if (!texto) return [];
  return texto
    .split(/\s*·\s*|\s*;\s*|(?:^|\s)\d\)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

// A cada pieza se le asigna la primera fecha con ese día de la semana que caiga
// desde `base` en adelante. Si dos piezas cayeran el mismo día, la segunda va a
// la semana siguiente en vez de pisarse.
export function fecharPiezas(piezas, base = new Date()) {
  const inicio = aMedianoche(base);
  const usadas = new Set();

  return piezas.map((p) => {
    let d = new Date(inicio);
    const salto = (p.dia_indice - d.getUTCDay() + 7) % 7;
    d.setUTCDate(d.getUTCDate() + salto);
    while (usadas.has(claveFecha(d))) d.setUTCDate(d.getUTCDate() + 7);
    usadas.add(claveFecha(d));
    return { ...p, fecha: claveFecha(d) };
  });
}

// Se trabaja en UTC a propósito: los eventos son de día completo, así que la hora
// no importa y usar UTC evita que un corrimiento de zona mueva una pieza al día
// anterior.
function aMedianoche(fecha) {
  const d = new Date(fecha);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const claveFecha = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// .ics — para Google Calendar, Apple Calendar, Outlook
// ---------------------------------------------------------------------------

export function generarIcs(piezas, { nombre = 'Mi semana de contenido', ahora = new Date() } = {}) {
  const sello = ahora.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Synoma//Founders//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escaparIcs(nombre)}`,
  ];

  piezas.forEach((p, i) => {
    const compacta = p.fecha.replace(/-/g, '');
    const siguiente = diaSiguiente(p.fecha);

    const titulo = [p.formato, p.gancho].filter(Boolean).join(': ') || 'Pieza de contenido';
    const detalle = [
      p.pilar ? `Pilar: ${p.pilar}` : null,
      p.dolor ? `Dolor que ataca: ${p.dolor}` : null,
      p.punteo?.length ? `Punteo:\n${p.punteo.map((x) => `  - ${x}`).join('\n')}` : null,
      p.intencion ? `Intención: ${p.intencion}` : null,
      p.tiempo ? `Tiempo de producción: ${p.tiempo}` : null,
      '',
      'Generado por Synoma · Founders Business Strategists',
    ].filter((x) => x !== null).join('\n');

    lineas.push(
      'BEGIN:VEVENT',
      // El UID tiene que ser estable para que reimportar actualice el evento en
      // lugar de duplicarlo.
      `UID:synoma-${compacta}-${i}@foundersbs.com`,
      `DTSTAMP:${sello}`,
      // Evento de día completo: nadie sabe a qué hora va a grabar, y poner una
      // hora inventada le llena la agenda de bloques falsos.
      `DTSTART;VALUE=DATE:${compacta}`,
      `DTEND;VALUE=DATE:${siguiente}`,
      `SUMMARY:${escaparIcs(recortar(titulo, 120))}`,
      `DESCRIPTION:${escaparIcs(detalle)}`,
      `CATEGORIES:${escaparIcs(p.intencion === 'venta' ? 'Synoma,Venta' : 'Synoma,Educativa')}`,
      'END:VEVENT',
    );
  });

  lineas.push('END:VCALENDAR');

  // CRLF y plegado a 75 octetos: es lo que pide el RFC 5545. Sin plegar, una
  // descripción larga hace que Outlook descarte el evento entero.
  return lineas.flatMap(plegar).join('\r\n') + '\r\n';
}

function escaparIcs(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function plegar(linea) {
  if (linea.length <= 75) return [linea];
  const partes = [linea.slice(0, 75)];
  let resto = linea.slice(75);
  while (resto.length > 74) {
    partes.push(' ' + resto.slice(0, 74));
    resto = resto.slice(74);
  }
  if (resto) partes.push(' ' + resto);
  return partes;
}

function diaSiguiente(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return claveFecha(d).replace(/-/g, '');
}

const recortar = (v, n) => (String(v ?? '').length > n ? String(v).slice(0, n - 1) + '…' : String(v ?? ''));

// ---------------------------------------------------------------------------
// .csv — para Excel y Google Sheets
// ---------------------------------------------------------------------------

// Marca de orden de bytes. Es lo que hace que Excel en Windows abra las tildes
// bien en vez de mostrar "Miércoles" como "Miércoles".
const BOM = '\ufeff';

export function generarCsv(piezas) {
  const cab = ['Fecha', 'Día', 'Pilar', 'Formato', 'Dolor', 'Gancho', 'Punteo', 'Intención', 'Tiempo', 'Publicada'];
  const filas = piezas.map((p) => [
    p.fecha, p.dia, p.pilar, p.formato, p.dolor, p.gancho,
    (p.punteo ?? []).join(' · '), p.intencion, p.tiempo, '',
  ]);

  // El BOM es lo que hace que Excel en Windows abra las tildes bien en vez de
  // mostrar "Mi√©rcoles". Sin él, medio archivo se ve roto.
  return BOM + [cab, ...filas].map((f) => f.map(celdaCsv).join(',')).join('\r\n') + '\r\n';
}

function celdaCsv(v) {
  const s = String(v ?? '');
  // El guion inicial se escapa: Excel interpreta una celda que arranca con = + -
  // o @ como fórmula, y un gancho que empieza con "-" se puede volver ejecutable.
  const seguro = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${seguro.replace(/"/g, '""')}"`;
}
