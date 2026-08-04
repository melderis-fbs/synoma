ALTER TABLE perfiles ADD COLUMN IF NOT EXISTS fundacion TEXT NOT NULL DEFAULT '';

ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS cerrada_en TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS conversaciones_abierta
  ON conversaciones (cliente_id) WHERE cerrada_en IS NULL;