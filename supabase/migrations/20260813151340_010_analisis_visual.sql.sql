/*
# Tabla para análisis visual de contenido

1. New Tables
- `analisis_visual`
  - `id` (uuid, primary key)
  - `cliente_id` (uuid, foreign key to clientes.id)
  - `tipo` (text: 'diagnostico' o 'chequeo')
  - `resultado` (text: el diagnóstico completo devuelto por la IA)
  - `imagenes` (int: cantidad de imágenes analizadas)
  - `creado_en` (timestamptz, default now())
2. Security
- Enable RLS on `analisis_visual`.
- Owner-scoped CRUD: each authenticated client can only access their own analyses.
- Note: this app uses Supabase Auth (authenticated role).
*/
CREATE TABLE IF NOT EXISTS analisis_visual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('diagnostico','chequeo')),
  resultado text NOT NULL,
  imagenes int NOT NULL DEFAULT 1,
  creado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE analisis_visual ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_analisis_visual" ON analisis_visual;
CREATE POLICY "select_own_analisis_visual" ON analisis_visual FOR SELECT
  TO authenticated USING (auth.uid() = cliente_id);

DROP POLICY IF EXISTS "insert_own_analisis_visual" ON analisis_visual;
CREATE POLICY "insert_own_analisis_visual" ON analisis_visual FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = cliente_id);

DROP POLICY IF EXISTS "update_own_analisis_visual" ON analisis_visual;
CREATE POLICY "update_own_analisis_visual" ON analisis_visual FOR UPDATE
  TO authenticated USING (auth.uid() = cliente_id) WITH CHECK (auth.uid() = cliente_id);

DROP POLICY IF EXISTS "delete_own_analisis_visual" ON analisis_visual;
CREATE POLICY "delete_own_analisis_visual" ON analisis_visual FOR DELETE
  TO authenticated USING (auth.uid() = cliente_id);

CREATE INDEX IF NOT EXISTS idx_analisis_visual_cliente ON analisis_visual(cliente_id, creado_en DESC);
