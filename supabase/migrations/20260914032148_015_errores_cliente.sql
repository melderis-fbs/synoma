/*
# Create errores_cliente table (client-side error logging)

1. New Tables
   - `errores_cliente`
     - `id` (uuid, primary key)
     - `cliente_id` (text, nullable) — the logged-in client's ID, if available
     - `mensaje` (text, not null) — the error message
     - `stack` (text) — full stack trace
     - `pantalla` (text) — which screen the user was on (URL hash or section name)
     - `user_agent` (text) — browser user-agent string
     - `creado_en` (timestamptz, defaults to now)

2. Security
   - Enable RLS on `errores_cliente`.
   - Allow anon + authenticated INSERT so the browser can log errors
     even before or without authentication.
   - SELECT restricted to anon + authenticated for admin queries via
     execute_sql (service role bypasses RLS anyway).
   - No UPDATE or DELETE needed from the client.

3. Notes
   - cliente_id is text (not FK) because the error handler must work even
     when the client record is unknown or the session is invalid.
   - Index on cliente_id + creado_en for efficient queries.
*/

CREATE TABLE IF NOT EXISTS errores_cliente (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id text,
  mensaje text NOT NULL,
  stack text,
  pantalla text,
  user_agent text,
  creado_en timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_errores_cliente_lookup ON errores_cliente(cliente_id, creado_en DESC);

ALTER TABLE errores_cliente ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "insert_errores_cliente" ON errores_cliente;
CREATE POLICY "insert_errores_cliente" ON errores_cliente FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "select_errores_cliente" ON errores_cliente;
CREATE POLICY "select_errores_cliente" ON errores_cliente FOR SELECT
  TO anon, authenticated USING (true);
