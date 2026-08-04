CREATE TABLE IF NOT EXISTS piezas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo       TEXT NOT NULL DEFAULT 'otro'
               CHECK (tipo IN ('plan', 'idea', 'guion', 'gancho', 'historia',
                               'venta', 'post', 'reciclado', 'revision', 'otro')),
  titulo     TEXT NOT NULL DEFAULT '',
  contenido  TEXT NOT NULL,
  comando    TEXT,
  estado     TEXT NOT NULL DEFAULT 'nueva'
               CHECK (estado IN ('nueva', 'grabada', 'publicada', 'archivada')),
  publicado_en   TIMESTAMPTZ,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piezas_cliente ON piezas (cliente_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS piezas_estado ON piezas (cliente_id, estado);