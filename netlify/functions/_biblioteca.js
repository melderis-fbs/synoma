// Synoma Founders — la biblioteca de contenidos
//
// Cada pieza que Synoma produce se guarda como una fila propia, aparte del chat.
// El chat es la conversación; la biblioteca es el resultado. Buscar un guion
// dentro de 200 mensajes no es una biblioteca, es un cajón.
//
// Qué se guarda solo y qué no: se guardan los comandos que producen algo
// PUBLICABLE (ver TIPOS). No se guardan /fundacion, /pilares, /persona,
// /hottakes ni /banco, porque eso es identidad y ya tiene su lugar en el perfil;
// ni /racha, que es un repaso. Cualquier respuesta se puede guardar a mano desde
// el botón de la burbuja.
//
// Las piezas NO se purgan a los 90 días como el chat. La conversación es
// andamiaje; el contenido producido es el activo del cliente.

import { getSql } from './_db.js';

// Comando → tipo de pieza. Lo que no está acá no se guarda automáticamente.
const TIPOS = {
  '/semana': 'plan',
  '/idea': 'idea',
  '/guion': 'guion',
  '/gancho': 'gancho',
  '/historias': 'historia',
  '/venta': 'venta',
  '/post': 'post',
  '/repurpose': 'reciclado',
  '/revisar': 'revision',
};

export const ESTADOS = ['nueva', 'grabada', 'publicada', 'archivada'];

const MAX_TITULO = 120;
const MAX_CONTENIDO = 40000;

// ---------------------------------------------------------------------------
// De un mensaje a una pieza
// ---------------------------------------------------------------------------

// Devuelve { tipo, comando, argumento } si el mensaje arranca con un comando que
// produce contenido publicable, o null si no hay que guardar nada.
export function clasificar(pregunta) {
  const texto = String(pregunta ?? '').trim();
  if (!texto.startsWith('/')) return null;

  // El comando es la primera palabra; el resto es el argumento.
  const corte = texto.search(/\s/);
  const comando = (corte === -1 ? texto : texto.slice(0, corte)).toLowerCase();
  const argumento = corte === -1 ? '' : texto.slice(corte + 1).trim();

  const tipo = TIPOS[comando];
  if (!tipo) return null;
  return { tipo, comando, argumento };
}

// El título de la grilla. El argumento del comando es casi siempre la mejor
// opción: "/guion cómo elegir un nutricionista" ya dice qué es la pieza. Cuando
// no hay argumento (/semana, /historias) se usa la primera línea con texto de la
// respuesta, sin los asteriscos ni los numerales del markdown.
export function titularPieza({ argumento, respuesta, tipo }) {
  const limpio = (s) => String(s ?? '')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const arg = limpio(argumento);
  if (arg) return arg.slice(0, MAX_TITULO);

  for (const linea of String(respuesta ?? '').split('\n')) {
    const l = limpio(linea);
    // Se saltean las líneas decorativas: separadores, tablas vacías, viñetas
    // solas. Sin esto la mitad de los títulos serían "---".
    if (l.length >= 8 && /[a-záéíóúñ]/i.test(l)) return l.slice(0, MAX_TITULO);
  }

  return ETIQUETAS[tipo] ?? 'Contenido';
}

// Nombre legible por tipo. Se usa como título de reserva y en la grilla.
export const ETIQUETAS = {
  plan: 'Plan semanal',
  idea: 'Ideas',
  guion: 'Guion',
  gancho: 'Ganchos',
  historia: 'Historias',
  venta: 'Pieza de venta',
  post: 'Post',
  reciclado: 'Contenido reciclado',
  revision: 'Revisión',
  otro: 'Contenido',
};

// ---------------------------------------------------------------------------
// Guardar
// ---------------------------------------------------------------------------

export async function guardarPieza(clienteId, { tipo, titulo, contenido, comando }) {
  const cuerpo = String(contenido ?? '').trim().slice(0, MAX_CONTENIDO);
  if (!cuerpo) return null;

  const tipoValido = ETIQUETAS[tipo] ? tipo : 'otro';
  const sql = getSql();
  const rows = await sql`
    INSERT INTO piezas (cliente_id, tipo, titulo, contenido, comando)
    VALUES (${clienteId}, ${tipoValido},
            ${String(titulo ?? '').slice(0, MAX_TITULO)}, ${cuerpo},
            ${comando ? String(comando).slice(0, 40) : null})
    RETURNING id, tipo, titulo, estado, creado_en
  `;
  return rows[0] ?? null;
}

// Se llama después de responder, igual que registrarUso: si el comando produce
// contenido publicable, queda en la biblioteca sin que el cliente haga nada.
export async function guardarSiEsPieza(clienteId, pregunta, respuesta) {
  const clase = clasificar(pregunta);
  if (!clase) return null;
  return guardarPieza(clienteId, {
    tipo: clase.tipo,
    comando: clase.comando,
    titulo: titularPieza({ argumento: clase.argumento, respuesta, tipo: clase.tipo }),
    contenido: respuesta,
  });
}

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

// La grilla. Se devuelve el contenido completo porque el cliente lo va a querer
// copiar; son sus propias piezas y ya viajaron una vez por el chat.
export async function listarPiezas(clienteId, { estado = null, tipo = null, limite = 200 } = {}) {
  const sql = getSql();
  const n = Math.max(1, Math.min(500, Number(limite) || 200));

  // Los filtros van como parámetros con un OR sobre NULL en vez de armar el SQL
  // a mano. Concatenar texto en una consulta es cómo se escriben las inyecciones.
  const rows = await sql`
    SELECT id, tipo, titulo, contenido, comando, estado, publicado_en, creado_en
    FROM piezas
    WHERE cliente_id = ${clienteId}
      AND (${estado}::text IS NULL OR estado = ${estado})
      AND (${tipo}::text   IS NULL OR tipo   = ${tipo})
    ORDER BY creado_en DESC
    LIMIT ${n}
  `;
  return rows;
}

// Resumen compacto para /racha: qué produjo, qué publicó y qué quedó pendiente.
// Va como bloque extra del system SOLO cuando el mensaje es /racha, para no
// pagar estos tokens en cada pedido.
export async function resumenParaRacha(clienteId, limite = 20) {
  const sql = getSql();
  const rows = await sql`
    SELECT tipo, titulo, estado, creado_en, publicado_en
    FROM piezas
    WHERE cliente_id = ${clienteId}
      AND creado_en > now() - INTERVAL '45 days'
    ORDER BY creado_en DESC
    LIMIT ${Math.max(1, Math.min(60, Number(limite) || 20))}
  `;
  return rows;
}

// Arma el texto que ve el modelo. Si no hay piezas se dice explícitamente, para
// que no invente un repaso de contenido que nunca existió.
export function bloqueDeRacha(piezas) {
  if (!piezas?.length) {
    return [
      '=== BIBLIOTECA DEL CLIENTE (últimos 45 días) ===',
      '(vacía — todavía no generó ninguna pieza con Synoma)',
      'No inventes un repaso: preguntale qué viene publicando por fuera de acá.',
      '=== FIN DE LA BIBLIOTECA ===',
    ].join('\n');
  }

  const fecha = (v) => (v ? String(v).slice(0, 10) : '—');
  const lineas = piezas.map((p) =>
    `· [${p.estado}] ${ETIQUETAS[p.tipo] ?? p.tipo} — ${p.titulo || 'sin título'} `
    + `(creada ${fecha(p.creado_en)}${p.publicado_en ? `, publicada ${fecha(p.publicado_en)}` : ''})`);

  const publicadas = piezas.filter((p) => p.estado === 'publicada').length;
  const pendientes = piezas.filter((p) => p.estado === 'nueva').length;

  return [
    '=== BIBLIOTECA DEL CLIENTE (últimos 45 días) ===',
    `Total ${piezas.length} · publicadas ${publicadas} · sin grabar todavía ${pendientes}`,
    ...lineas,
    '=== FIN DE LA BIBLIOTECA ===',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Cambiar y borrar
// ---------------------------------------------------------------------------

// El filtro por cliente_id va en el WHERE junto al id: sin eso, alguien con el
// id de una pieza ajena podría cambiarle el estado o borrarla.
export async function cambiarEstado(clienteId, piezaId, estado) {
  if (!ESTADOS.includes(estado)) return null;
  const sql = getSql();

  // publicado_en se llena al pasar a 'publicada' y se limpia si vuelve atrás,
  // así la fecha nunca miente sobre una pieza que se despublicó.
  const rows = await sql`
    UPDATE piezas
    SET estado = ${estado},
        publicado_en = CASE WHEN ${estado} = 'publicada' THEN coalesce(publicado_en, now()) ELSE NULL END,
        actualizado_en = now()
    WHERE id = ${piezaId} AND cliente_id = ${clienteId}
    RETURNING id, estado, publicado_en
  `;
  return rows[0] ?? null;
}

export async function borrarPieza(clienteId, piezaId) {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM piezas WHERE id = ${piezaId} AND cliente_id = ${clienteId} RETURNING id
  `;
  return rows.length > 0;
}
