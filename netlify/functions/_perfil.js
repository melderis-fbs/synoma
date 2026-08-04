// Synoma Founders — perfil y uso, en la base de datos
//
// Antes el perfil vivía en Netlify Blobs indexado por el código compartido, y
// el contador de uso también. Los dos se mudan acá y quedan colgados de la
// identidad real del cliente, no de un código que se puede reenviar.
//
// Ventaja concreta para el cliente: cambia de teléfono y su identidad de marca
// sigue ahí. Antes se perdía cada vez que Safari limpiaba el localStorage.

import { getSql } from './_db.js';

// Mismos topes que la v1: son el presupuesto de tokens del prompt.
// fundacion es más chica a propósito: son ocho bloques de pocas líneas cada uno,
// no un documento. Si alguien pega ahí su Manual entero, el prompt se infla y el
// modelo pierde el foco en lo que importa.
export const LIMITES_PERFIL = { manual: 30000, oferta: 15000, encuesta: 10000, fundacion: 8000 };

const recortar = (v, max) => String(v ?? '').trim().slice(0, max);

export async function leerPerfil(clienteId) {
  const sql = getSql();
  const rows = await sql`
    SELECT manual, oferta, encuesta, fundacion, actualizado_en
    FROM perfiles WHERE cliente_id = ${clienteId}
  `;
  return rows[0] ?? null;
}

export async function guardarPerfil(clienteId, entrada) {
  const sql = getSql();
  const perfil = {
    manual: recortar(entrada?.manual, LIMITES_PERFIL.manual),
    oferta: recortar(entrada?.oferta, LIMITES_PERFIL.oferta),
    encuesta: recortar(entrada?.encuesta, LIMITES_PERFIL.encuesta),
    fundacion: recortar(entrada?.fundacion, LIMITES_PERFIL.fundacion),
  };

  // Se rechaza un perfil sin oferta: sin ella Synoma escribe genérico, que es
  // exactamente lo que el producto promete no hacer. Y si se aceptara, un
  // cliente que abre la pantalla y guarda sin pegar nada se borraría el suyo.
  if (!perfil.oferta) return { ok: false, motivo: 'sin_oferta' };

  const rows = await sql`
    INSERT INTO perfiles (cliente_id, manual, oferta, encuesta, fundacion)
    VALUES (${clienteId}, ${perfil.manual}, ${perfil.oferta}, ${perfil.encuesta}, ${perfil.fundacion})
    ON CONFLICT (cliente_id) DO UPDATE SET
      manual         = EXCLUDED.manual,
      oferta         = EXCLUDED.oferta,
      encuesta       = EXCLUDED.encuesta,
      fundacion      = EXCLUDED.fundacion,
      actualizado_en = now()
    RETURNING actualizado_en
  `;

  return { ok: true, actualizado_en: rows[0]?.actualizado_en };
}

// Arma el bloque de texto que va al prompt. Está acá y no en synoma.js para que
// sea imposible que el formato cambie en un lado y no en el otro: el bloque es
// parte del prefijo cacheado, y un byte distinto invalida el caché en silencio.
export function bloqueDePerfil(p) {
  const parte = (v, vacio) => {
    const s = String(v ?? '').trim();
    return s || vacio;
  };
  return [
    '=== PERFIL DEL CLIENTE (su identidad — usala en TODO) ===',
    // Primero la Fundación: es el bloque que define pilares, persona y voz, o
    // sea el que decide si la pieza sale suya o genérica. Va arriba para que sea
    // lo primero que el modelo tiene presente al planificar.
    '--- SUS BASES (las 8 que definen su marca) ---',
    parte(p?.fundacion, '(no cargada — si te hace falta un bloque, pedíselo, y ofrecele el comando /fundacion)'),
    '--- SU MANUAL DE TRANSFORMACIÓN ---',
    parte(p?.manual, '(no cargado — pedile que lo cargue en "Mi identidad")'),
    '--- SU OFERTA EN UNA PÁGINA ---',
    parte(p?.oferta, '(no cargada)'),
    '--- FRASES TEXTUALES DE SU ENCUESTA ---',
    parte(p?.encuesta, '(no cargadas)'),
    '=== FIN DEL PERFIL ===',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Uso
// ---------------------------------------------------------------------------

export async function mensajesDeHoy(clienteId) {
  const sql = getSql();
  const rows = await sql`
    SELECT mensajes FROM uso_diario
    WHERE cliente_id = ${clienteId} AND fecha = current_date
  `;
  return rows[0]?.mensajes ?? 0;
}

// Se llama después de responder, con lo que informó la API. Los tokens de
// entrada cacheados van aparte porque cuestan el 10%: sumarlos juntos haría que
// el costo por cliente que ve Vicky sea casi el triple del real.
export async function registrarUso(clienteId, usage = {}) {
  const sql = getSql();
  const entrada = Number(usage.input_tokens ?? 0);
  const cache = Number(usage.cache_read_input_tokens ?? 0)
              + Number(usage.cache_creation_input_tokens ?? 0);
  const salida = Number(usage.output_tokens ?? 0);

  await sql`
    INSERT INTO uso_diario (cliente_id, fecha, mensajes, tokens_entrada, tokens_entrada_cache, tokens_salida)
    VALUES (${clienteId}, current_date, 1, ${entrada}, ${cache}, ${salida})
    ON CONFLICT (cliente_id, fecha) DO UPDATE SET
      mensajes             = uso_diario.mensajes + 1,
      tokens_entrada       = uso_diario.tokens_entrada + EXCLUDED.tokens_entrada,
      tokens_entrada_cache = uso_diario.tokens_entrada_cache + EXCLUDED.tokens_entrada_cache,
      tokens_salida        = uso_diario.tokens_salida + EXCLUDED.tokens_salida
  `;
}
