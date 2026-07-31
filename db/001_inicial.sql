-- Synoma Founders — esquema inicial
--
-- Se aplica solo en cada deploy (ver scripts/migrar.js). Es idempotente: correrlo
-- dos veces no rompe nada.
--
-- Decisiones que vale la pena tener presentes al leer esto:
--
-- 1. La identidad es el EMAIL, no un código. El email es lo único que el cliente
--    siempre tiene a mano y que no se puede pasar por Telegram sin que se note.
--
-- 2. GHL es la fuente de verdad de QUIÉN tiene acceso, pero acá se guarda una
--    copia. Sin esa copia habría que llamar a GHL en cada pedido: más lento y
--    contra sus límites de uso. Se refresca cada tanto, no en cada request.
--
-- 3. El acceso NO se ata a "es miembro de Founders". Se ata a un estado propio
--    de Synoma, para que alguien que termina el programa pueda seguir pagando y
--    usándolo. Ese era el requisito que cambiaba todo.
--
-- 4. Las conversaciones se guardan para que le queden al cliente, pero NO se
--    construye ninguna pantalla que las muestre del lado de Vicky, y se borran
--    a los 90 días. Lo que no está guardado no se puede filtrar.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- para gen_random_uuid()

-- ---------------------------------------------------------------------------
-- clientes — la identidad y la puerta
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Guardado siempre en minúsculas y sin espacios. La app normaliza antes de
  -- escribir; el índice único de abajo lo garantiza igual.
  email             TEXT NOT NULL,
  nombre            TEXT,

  -- Para poder volver al contacto en GHL desde el panel de admin.
  ghl_contact_id    TEXT,

  -- La puerta. 'activo' entra, cualquier otra cosa no.
  acceso            TEXT NOT NULL DEFAULT 'suspendido'
                      CHECK (acceso IN ('activo', 'suspendido')),

  -- Por qué tiene acceso. Sirve para saber a quién ofrecerle la suscripción
  -- cuando termine el programa.
  origen_acceso     TEXT NOT NULL DEFAULT 'founders'
                      CHECK (origen_acceso IN ('founders', 'suscripcion', 'manual')),

  -- Cuándo se consultó GHL por última vez para este cliente.
  ghl_verificado_en TIMESTAMPTZ,

  -- Para que Vicky pueda anotar cosas en el panel.
  notas             TEXT,

  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_acceso_en  TIMESTAMPTZ
);

-- Único por email, insensible a mayúsculas. Sin esto, dos filas para la misma
-- persona y el perfil se parte en dos.
CREATE UNIQUE INDEX IF NOT EXISTS clientes_email_unico ON clientes (lower(email));
CREATE INDEX IF NOT EXISTS clientes_ghl ON clientes (ghl_contact_id);
CREATE INDEX IF NOT EXISTS clientes_acceso ON clientes (acceso);

-- ---------------------------------------------------------------------------
-- perfiles — la identidad de marca del cliente
-- ---------------------------------------------------------------------------
-- Esto es lo que hace que Synoma escriba con su voz y no genérico. Es el dato
-- más valioso del sistema y el que antes se perdía cuando Safari borraba el
-- localStorage.
CREATE TABLE IF NOT EXISTS perfiles (
  cliente_id     UUID PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  manual         TEXT NOT NULL DEFAULT '',
  oferta         TEXT NOT NULL DEFAULT '',
  encuesta       TEXT NOT NULL DEFAULT '',
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- codigos_acceso — el código de 6 dígitos que se manda por email
-- ---------------------------------------------------------------------------
-- Va por email y no por cliente_id porque cuando alguien pide un código todavía
-- puede no existir como cliente.
--
-- Se guarda el HASH, no el código. Si alguien accediera a la base de datos no
-- podría usar los códigos pendientes.
CREATE TABLE IF NOT EXISTS codigos_acceso (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  codigo_hash TEXT NOT NULL,
  expira_en   TIMESTAMPTZ NOT NULL,

  -- Tope de intentos: sin esto, seis dígitos se prueban por fuerza bruta.
  intentos    SMALLINT NOT NULL DEFAULT 0,
  usado_en    TIMESTAMPTZ,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codigos_email ON codigos_acceso (lower(email), creado_en DESC);
CREATE INDEX IF NOT EXISTS codigos_expira ON codigos_acceso (expira_en);

-- ---------------------------------------------------------------------------
-- sesiones — el "quedate adentro 60 días"
-- ---------------------------------------------------------------------------
-- Igual que con los códigos, se guarda el hash del token y no el token. Una
-- filtración de la base no permite hacerse pasar por nadie.
CREATE TABLE IF NOT EXISTS sesiones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id    UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expira_en     TIMESTAMPTZ NOT NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Para detectar una cuenta compartida entre varias personas.
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS sesiones_cliente ON sesiones (cliente_id);
CREATE INDEX IF NOT EXISTS sesiones_expira ON sesiones (expira_en);

-- ---------------------------------------------------------------------------
-- conversaciones y mensajes — el chat que le queda al cliente
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversaciones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  titulo         TEXT,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversaciones_cliente
  ON conversaciones (cliente_id, actualizado_en DESC);

CREATE TABLE IF NOT EXISTS mensajes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id UUID NOT NULL REFERENCES conversaciones(id) ON DELETE CASCADE,
  rol             TEXT NOT NULL CHECK (rol IN ('user', 'assistant')),
  contenido       TEXT NOT NULL,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mensajes_conversacion ON mensajes (conversacion_id, creado_en);

-- Para el borrado a los 90 días.
CREATE INDEX IF NOT EXISTS mensajes_creado ON mensajes (creado_en);

-- ---------------------------------------------------------------------------
-- uso_diario — cuánto consume cada cliente
-- ---------------------------------------------------------------------------
-- Una fila por cliente y por día. Sirve para tres cosas: el tope de mensajes,
-- ver el costo real por cliente, y detectar una cuenta compartida.
CREATE TABLE IF NOT EXISTS uso_diario (
  cliente_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha          DATE NOT NULL,
  mensajes       INTEGER NOT NULL DEFAULT 0,

  -- Desglosado porque las lecturas de caché cuestan el 10%: sin separarlas, el
  -- costo calculado sería casi el triple del real.
  tokens_entrada       BIGINT NOT NULL DEFAULT 0,
  tokens_entrada_cache BIGINT NOT NULL DEFAULT 0,
  tokens_salida        BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (cliente_id, fecha)
);

CREATE INDEX IF NOT EXISTS uso_fecha ON uso_diario (fecha DESC);

-- ---------------------------------------------------------------------------
-- Vista para el panel de admin
-- ---------------------------------------------------------------------------
-- Todo lo que Vicky necesita ver en una sola consulta. Deliberadamente NO
-- incluye nada del contenido de los perfiles ni de los mensajes: solo si están
-- cargados y cuánto se usó.
CREATE OR REPLACE VIEW panel_clientes AS
SELECT
  c.id,
  c.email,
  c.nombre,
  c.acceso,
  c.origen_acceso,
  c.creado_en,
  c.ultimo_acceso_en,

  -- Si el perfil está completo o no es la causa nº 1 de que el contenido salga
  -- genérico. Se mide sin leer una sola palabra de lo que escribió.
  (p.cliente_id IS NOT NULL)                     AS perfil_cargado,
  (length(p.oferta) > 0)                         AS tiene_oferta,
  (length(p.manual) > 0)                         AS tiene_manual,
  (length(p.encuesta) > 0)                       AS tiene_encuesta,
  length(coalesce(p.manual, '') || coalesce(p.oferta, '') || coalesce(p.encuesta, ''))
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
