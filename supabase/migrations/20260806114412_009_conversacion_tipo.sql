/*
# Add tipo column to conversaciones

1. Modified Tables
- `conversaciones`: add `tipo TEXT NOT NULL DEFAULT 'synoma'` to distinguish
  Synoma chats from Vicky chats. Existing rows default to 'synoma'.
2. Security
- No RLS changes (table already locked down; all access goes through the
  edge function with the service role key).
3. Notes
- The column is CHECK-constrained to 'synoma' or 'vicky' so no other values
  can be inserted.
- An index on (cliente_id, tipo, actualizado_en DESC) is added so the edge
  function can efficiently find the latest conversation of each type.
*/

ALTER TABLE conversaciones
  ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'synoma'
  CHECK (tipo IN ('synoma', 'vicky'));

CREATE INDEX IF NOT EXISTS conversaciones_cliente_tipo
  ON conversaciones (cliente_id, tipo, actualizado_en DESC);
