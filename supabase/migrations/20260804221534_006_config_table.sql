CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_config" ON config;
CREATE POLICY "anon_read_config" ON config FOR SELECT TO anon, authenticated USING (clave = 'anthropic_key');
