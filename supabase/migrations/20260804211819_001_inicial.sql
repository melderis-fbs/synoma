CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clientes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  nombre            TEXT,
  ghl_contact_id    TEXT,
  acceso            TEXT NOT NULL DEFAULT 'suspendido'
                      CHECK (acceso IN ('activo', 'suspendido')),
  origen_acceso     TEXT NOT NULL DEFAULT 'founders'
                      CHECK (origen_acceso IN ('founders', 'suscripcion', 'manual')),
  ghl_verificado_en TIMESTAMPTZ,
  notas             TEXT,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_acceso_en  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS clientes_email_unico ON clientes (lower(email));
CREATE INDEX IF NOT EXISTS clientes_ghl ON clientes (ghl_contact_id);
CREATE INDEX IF NOT EXISTS clientes_acceso ON clientes (acceso);

CREATE TABLE IF NOT EXISTS perfiles (
  cliente_id     UUID PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  manual         TEXT NOT NULL DEFAULT '',
  oferta         TEXT NOT NULL DEFAULT '',
  encuesta       TEXT NOT NULL DEFAULT '',
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS codigos_acceso (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  codigo_hash TEXT NOT NULL,
  expira_en   TIMESTAMPTZ NOT NULL,
  intentos    SMALLINT NOT NULL DEFAULT 0,
  usado_en    TIMESTAMPTZ,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS codigos_email ON codigos_acceso (lower(email), creado_en DESC);
CREATE INDEX IF NOT EXISTS codigos_expira ON codigos_acceso (expira_en);

CREATE TABLE IF NOT EXISTS sesiones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id    UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  expira_en     TIMESTAMPTZ NOT NULL,
  creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_uso_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent    TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS sesiones_cliente ON sesiones (cliente_id);
CREATE INDEX IF NOT EXISTS sesiones_expira ON sesiones (expira_en);

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
CREATE INDEX IF NOT EXISTS mensajes_creado ON mensajes (creado_en);

CREATE TABLE IF NOT EXISTS uso_diario (
  cliente_id     UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  fecha          DATE NOT NULL,
  mensajes       INTEGER NOT NULL DEFAULT 0,
  tokens_entrada       BIGINT NOT NULL DEFAULT 0,
  tokens_entrada_cache BIGINT NOT NULL DEFAULT 0,
  tokens_salida        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (cliente_id, fecha)
);

CREATE INDEX IF NOT EXISTS uso_fecha ON uso_diario (fecha DESC);

CREATE TABLE IF NOT EXISTS migraciones (
  nombre      TEXT PRIMARY KEY,
  aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO migraciones (nombre) VALUES
  ('001_inicial.sql'), ('002_fundacion_y_chat.sql'), ('003_biblioteca.sql')
ON CONFLICT DO NOTHING;
