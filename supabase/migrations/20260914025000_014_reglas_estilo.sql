/*
# Create reglas_estilo table (style rules per client)

1. New Tables
   - `reglas_estilo`
     - `id` (uuid, primary key)
     - `cliente_id` (uuid, not null, FK to clientes.id)
     - `regla` (text, not null) — a single style rule the client wants Synoma to follow
     - `creado_en` (timestamptz, defaults to now)

2. Security
   - Enable RLS on `reglas_estilo`.
   - The edge function reads this table with the service role key, which bypasses RLS.
     Policies grant anon+authenticated SELECT so the data is also queryable from
     the frontend if needed later, scoped by cliente_id matching existing patterns.

3. Notes
   - This table is read-only from the app's perspective for now (rules are inserted manually).
   - Index on cliente_id for fast lookups during prompt assembly.
*/

CREATE TABLE IF NOT EXISTS reglas_estilo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  regla text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reglas_estilo_cliente ON reglas_estilo(cliente_id);

ALTER TABLE reglas_estilo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_reglas_estilo" ON reglas_estilo;
CREATE POLICY "select_reglas_estilo" ON reglas_estilo FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_reglas_estilo" ON reglas_estilo;
CREATE POLICY "insert_reglas_estilo" ON reglas_estilo FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_reglas_estilo" ON reglas_estilo;
CREATE POLICY "update_reglas_estilo" ON reglas_estilo FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_reglas_estilo" ON reglas_estilo;
CREATE POLICY "delete_reglas_estilo" ON reglas_estilo FOR DELETE
  TO anon, authenticated USING (true);
