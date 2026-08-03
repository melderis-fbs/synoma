// Synoma Founders — el chat que le queda al cliente
//
// Las tablas `conversaciones` y `mensajes` estaban creadas desde el esquema
// inicial pero nadie escribía en ellas: el historial vivía solo en la memoria
// de la pestaña. Cerrabas la pestaña y Synoma se olvidaba de todo. Eso hacía que
// la app fuera un paso ATRÁS respecto del Proyecto de ChatGPT que los clientes
// ya usaban, donde el hilo queda.
//
// Ahora el historial vive en la base, colgado del cliente. Consecuencias:
//   · Entra desde el teléfono y sigue la conversación que dejó en la computadora.
//   · Safari le limpia el navegador y no pierde nada.
//   · El servidor deja de confiar en el historial que manda el navegador. Antes,
//     quien quisiera podía inyectar turnos falsos de "assistant" en el pedido y
//     hacerle decir a Synoma que ya había aceptado cualquier cosa.
//
// Lo que NO se hace, a propósito: no hay ninguna consulta en todo el proyecto
// que devuelva mensajes de OTRO cliente, y el panel de admin no los toca. Todo
// lo de acá filtra por cliente_id. Ver también purga.js: a los 90 días se borran.

import { getSql } from './_db.js';

// Cuánto se le manda a Claude como contexto, contado en MENSAJES (no en idas y
// vueltas): 24 mensajes = 12 preguntas con sus 12 respuestas. Cada mensaje que
// se agrega acá se paga en todos los pedidos siguientes, así que subirlo no es
// gratis; 12 idas y vueltas ≈ una sesión de trabajo entera, que es donde el
// cliente deja de notar que hay un corte.
export const MENSAJES_CONTEXTO = 24;

// Cuánto se le muestra al cliente al abrir la app. Más que el contexto: leer lo
// de la semana pasada no cuesta tokens, solo una consulta.
export const MENSAJES_PANTALLA = 60;

// Tope por mensaje guardado. Un /revisar con un borrador largo puede ser grande;
// más que esto es alguien pegando un libro.
const MAX_CHARS = 20000;

// Tope del historial COMPLETO que se le manda al modelo, en caracteres.
//
// Sin esto, 24 mensajes de 20.000 caracteres son 480.000 caracteres (~120.000
// tokens) en un solo pedido. Eso trae dos problemas, y el segundo es el grave:
//   1. Cuesta. Aunque el caché abarate el perfil, el historial no se cachea.
//   2. Cuanto más grande la entrada, más tarda la PRIMERA palabra. Y como
//      Netlify corta la función por duración total, un historial gordo hace que
//      el pedido muera antes de escribir nada.
// 40.000 caracteres son unas 12 páginas de conversación: de sobra para que no se
// note el corte, y acotado como para que el arranque sea rápido.
const MAX_CHARS_CONTEXTO = 40000;

const recortar = (v) => String(v ?? '').slice(0, MAX_CHARS);

// ---------------------------------------------------------------------------
// La conversación abierta
// ---------------------------------------------------------------------------

// Un hilo por cliente. El modelo de datos soporta varios (cada conversación
// tiene su id), pero la app abre uno solo: el cliente viene de un Proyecto de
// ChatGPT, que es un hilo continuo. Darle pestañas sería pedirle que administre
// algo que hoy no administra.
export async function conversacionAbierta(clienteId) {
  const sql = getSql();

  const existentes = await sql`
    SELECT id FROM conversaciones
    WHERE cliente_id = ${clienteId} AND cerrada_en IS NULL
    ORDER BY actualizado_en DESC
    LIMIT 1
  `;
  if (existentes[0]) return existentes[0].id;

  const creada = await sql`
    INSERT INTO conversaciones (cliente_id) VALUES (${clienteId})
    RETURNING id
  `;
  return creada[0].id;
}

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

// Devuelve los últimos `limite` mensajes en orden cronológico, listos tanto para
// mandarle a Claude como para pintar en pantalla.
//
// El ORDER BY del subselect es DESC para que el LIMIT agarre los ÚLTIMOS y no
// los primeros; después se da vuelta. Con ORDER BY ASC + LIMIT, un cliente con
// 400 mensajes recibiría los 12 del primer día.
export async function historial(clienteId, limite = MENSAJES_CONTEXTO) {
  const sql = getSql();
  const n = Math.max(1, Math.min(200, Number(limite) || MENSAJES_CONTEXTO));

  const rows = await sql`
    SELECT rol, contenido, creado_en FROM (
      SELECT m.rol, m.contenido, m.creado_en
      FROM mensajes m
      JOIN conversaciones c ON c.id = m.conversacion_id
      WHERE c.cliente_id = ${clienteId}
      ORDER BY m.creado_en DESC, m.id DESC
      LIMIT ${n}
    ) ultimos
    ORDER BY creado_en ASC
  `;

  return rows.map((r) => ({ role: r.rol, content: r.contenido, creado_en: r.creado_en }));
}

// El historial que se le manda al modelo: solo role y content, y nunca
// arrancando con un turno de 'assistant' (la API lo rechaza).
export function paraElModelo(mensajes) {
  let limpios = mensajes
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: recortar(m.content) }))
    .filter((m) => m.content.trim().length > 0);

  // Se recorta por caracteres, tirando lo MÁS VIEJO: la pregunta nueva y las
  // últimas respuestas son las que importan. El último mensaje entra siempre,
  // aunque solo él ya pase el tope: es el pedido del cliente.
  let total = 0;
  const dentro = [];
  for (let i = limpios.length - 1; i >= 0; i--) {
    total += limpios[i].content.length;
    if (total > MAX_CHARS_CONTEXTO && dentro.length > 0) break;
    dentro.unshift(limpios[i]);
  }
  limpios = dentro;

  while (limpios.length && limpios[0].role !== 'user') limpios.shift();

  // Se juntan los mensajes seguidos del mismo rol. La API espera que se vayan
  // alternando; dos turnos de 'user' pegados pueden aparecer si un mensaje quedó
  // vacío y se filtró arriba, y el resultado es un pedido que la API rechaza o
  // contesta cualquier cosa. Preferimos un hilo válido a uno fiel.
  const alternados = [];
  for (const m of limpios) {
    const anterior = alternados[alternados.length - 1];
    if (anterior && anterior.role === m.role) anterior.content += `\n\n${m.content}`;
    else alternados.push({ ...m });
  }

  return alternados;
}

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

// Se guarda el turno COMPLETO (pregunta + respuesta) recién cuando la respuesta
// terminó. Si se guardara la pregunta antes de llamar a Claude, cada llamada
// fallida dejaría un mensaje del cliente sin respuesta en el historial, y el
// pedido siguiente le mandaría al modelo un hilo lleno de preguntas colgadas.
//
// Si la respuesta se cortó a la mitad se guarda igual lo que llegó: es lo que el
// cliente tiene en pantalla, y que la base diga otra cosa lo confundiría.
export async function guardarTurno(clienteId, pregunta, respuesta) {
  const p = recortar(pregunta).trim();
  const r = recortar(respuesta).trim();
  if (!p || !r) return null;

  const sql = getSql();
  const conversacionId = await conversacionAbierta(clienteId);

  await sql`
    INSERT INTO mensajes (conversacion_id, rol, contenido)
    VALUES (${conversacionId}, 'user', ${p}), (${conversacionId}, 'assistant', ${r})
  `;

  // El título es la primera pregunta recortada. Sirve para que el día que haya
  // varias conversaciones se distingan; hoy no se muestra en ningún lado.
  await sql`
    UPDATE conversaciones
    SET actualizado_en = now(),
        titulo = coalesce(titulo, left(${p}, 80))
    WHERE id = ${conversacionId}
  `;

  return conversacionId;
}

// ---------------------------------------------------------------------------
// Borrar
// ---------------------------------------------------------------------------

// El cliente puede borrar su propio historial cuando quiera. Es su contenido:
// si lo usó para pensar en voz alta sobre su negocio, tiene que poder sacarlo
// sin pedirle permiso a nadie. El ON DELETE CASCADE de `mensajes` hace el resto.
export async function borrarChat(clienteId) {
  const sql = getSql();
  const rows = await sql`
    DELETE FROM conversaciones WHERE cliente_id = ${clienteId} RETURNING id
  `;
  return rows.length;
}
