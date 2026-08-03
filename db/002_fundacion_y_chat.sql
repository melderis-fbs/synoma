-- Synoma Founders — Fundación en el perfil, y el chat que le queda al cliente
--
-- Idempotente como la 001: correrla dos veces no rompe nada.
--
-- Dos cosas acá:
--
-- 1. perfiles.fundacion — los 8 bloques (porqué, objetivo, pilares, banco de
--    historias, creencias, su persona, mundo interno, voz). El comando
--    /fundacion los produce; sin una columna donde guardarlos, el resultado se
--    perdía apenas se cerraba la conversación y había que rehacerlo.
--
-- 2. conversaciones.ultimo_mensaje_en — las tablas de chat ya existían desde la
--    001 pero nunca se escribieron. Ahora sí, así que hace falta poder buscar
--    "la conversación viva de este cliente" sin recorrer sus mensajes.

-- ---------------------------------------------------------------------------
-- 1. La Fundación
-- ---------------------------------------------------------------------------
ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS fundacion TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- 2. El chat
-- ---------------------------------------------------------------------------
-- Una conversación viva por cliente. El modelo soporta varias (la tabla tiene
-- id propio), pero la app abre una sola: el cliente viene de un Proyecto de
-- ChatGPT, donde todo pasa en un hilo continuo. Meter pestañas de conversación
-- sería pedirle que administre algo que hoy no administra.
ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS cerrada_en TIMESTAMPTZ;

-- Buscar la conversación abierta del cliente es la consulta más frecuente de
-- todo el sistema: pasa una vez por cada mensaje enviado.
CREATE INDEX IF NOT EXISTS conversaciones_abierta
  ON conversaciones (cliente_id) WHERE cerrada_en IS NULL;

-- ---------------------------------------------------------------------------
-- 3. El panel de admin, con la Fundación
-- ---------------------------------------------------------------------------
-- Se recrea la vista porque CREATE OR REPLACE VIEW no deja insertar una columna
-- en el medio, y tiene_fundacion va con el resto de los "tiene_".
--
-- Igual que antes: SOLO se expone si el bloque está cargado y cuánto ocupa.
-- Nunca una palabra de lo que el cliente escribió, y nada de los mensajes.
DROP VIEW IF EXISTS panel_clientes;

CREATE VIEW panel_clientes AS
SELECT
  c.id,
  c.email,
  c.nombre,
  c.acceso,
  c.origen_acceso,
  c.creado_en,
  c.ultimo_acceso_en,

  (p.cliente_id IS NOT NULL)                     AS perfil_cargado,
  (length(p.oferta) > 0)                         AS tiene_oferta,
  (length(p.manual) > 0)                         AS tiene_manual,
  (length(p.encuesta) > 0)                       AS tiene_encuesta,
  (length(coalesce(p.fundacion, '')) > 0)        AS tiene_fundacion,
  length(coalesce(p.manual, '') || coalesce(p.oferta, '')
      || coalesce(p.encuesta, '') || coalesce(p.fundacion, ''))
                                                 AS perfil_caracteres,
  p.actualizado_en                               AS perfil_actualizado_en,

  coalesce(u30.mensajes, 0)                      AS mensajes_30d,
  coalesce(u30.tokens_entrada, 0)                AS tokens_entrada_30d,
  coalesce(u30.tokens_entrada_cache, 0)          AS tokens_cache_30d,
  coalesce(u30.tokens_salida, 0)                 AS tokens_salida_30d
FROM clientes c
LEFT JOIN perfiles p ON p.cliente_id = c.id
LEFT JOIN (
  SELECT cliente_id,
         sum(mensajes)             AS mensajes,
         sum(tokens_entrada)       AS tokens_entrada,
         sum(tokens_entrada_cache) AS tokens_entrada_cache,
         sum(tokens_salida)        AS tokens_salida
  FROM uso_diario
  WHERE fecha >= current_date - INTERVAL '30 days'
  GROUP BY cliente_id
) u30 ON u30.cliente_id = c.id;
