-- Synoma Founders — la biblioteca de contenidos del cliente
--
-- Idempotente como las anteriores.
--
-- El problema que resuelve: Synoma genera un guion buenísimo, el cliente lo lee,
-- sigue trabajando, y a los tres días no lo encuentra. Tiene que volver a
-- pedirlo (y sale distinto, porque el modelo no es determinista). El chat guarda
-- la conversación, pero buscar una pieza dentro de 200 mensajes no es una
-- biblioteca: es un cajón.
--
-- Diferencia importante con el chat: las PIEZAS NO SE PURGAN a los 90 días. La
-- conversación es andamiaje —se puede tirar— pero el contenido producido es el
-- activo del cliente. Se borra solo si él lo borra.

-- ---------------------------------------------------------------------------
-- piezas — cada contenido que Synoma produjo para el cliente
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS piezas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,

  -- Sale del comando que la generó, así el cliente puede filtrar la grilla por
  -- "mostrame solo mis guiones".
  tipo       TEXT NOT NULL DEFAULT 'otro'
               CHECK (tipo IN ('plan', 'idea', 'guion', 'gancho', 'historia',
                               'venta', 'post', 'reciclado', 'revision', 'otro')),

  -- El argumento del comando cuando lo hay (/guion cómo elegir un nutricionista),
  -- y si no la primera línea de la respuesta. Es lo que se ve en la grilla.
  titulo     TEXT NOT NULL DEFAULT '',
  contenido  TEXT NOT NULL,

  -- El comando literal, para poder repetir el pedido tal cual más adelante.
  comando    TEXT,

  -- El estado convierte la grilla en un tablero de producción. Sin esto es un
  -- archivo muerto: el cliente no distingue lo que ya publicó de lo que le falta
  -- grabar, que es justamente la pregunta que /racha necesita contestar.
  estado     TEXT NOT NULL DEFAULT 'nueva'
               CHECK (estado IN ('nueva', 'grabada', 'publicada', 'archivada')),

  -- Cuándo la publicó. Se llena al pasar a 'publicada' y sirve para medir ritmo.
  publicado_en   TIMESTAMPTZ,

  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta de la grilla: las piezas del cliente, las más nuevas arriba.
CREATE INDEX IF NOT EXISTS piezas_cliente ON piezas (cliente_id, creado_en DESC);

-- Para el filtro por estado y para el resumen que /racha le pasa al modelo.
CREATE INDEX IF NOT EXISTS piezas_estado ON piezas (cliente_id, estado);

-- ---------------------------------------------------------------------------
-- El panel de admin, con la biblioteca
-- ---------------------------------------------------------------------------
-- Se agregan DOS NÚMEROS: cuántas piezas produjo y cuántas publicó. Es la
-- métrica de adopción que importa —un cliente que genera y no publica necesita
-- otra conversación que uno que no genera— y se obtiene sin leer una palabra de
-- lo que escribió.
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
  coalesce(u30.tokens_salida, 0)                 AS tokens_salida_30d,

  coalesce(pz.total, 0)                          AS piezas_total,
  coalesce(pz.publicadas, 0)                     AS piezas_publicadas,
  pz.ultima_pieza_en                             AS ultima_pieza_en
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
) u30 ON u30.cliente_id = c.id
LEFT JOIN (
  -- count() y max(): ni un titulo ni un contenido salen de acá.
  SELECT cliente_id,
         count(*)                                          AS total,
         count(*) FILTER (WHERE estado = 'publicada')       AS publicadas,
         max(creado_en)                                     AS ultima_pieza_en
  FROM piezas
  GROUP BY cliente_id
) pz ON pz.cliente_id = c.id;
