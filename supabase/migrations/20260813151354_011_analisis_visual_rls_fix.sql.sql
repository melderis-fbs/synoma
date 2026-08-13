/*
# Fix RLS policies for analisis_visual (no Supabase Auth)

The app uses custom code-based auth, not Supabase Auth.
The edge function uses the service role key (bypasses RLS).
Replace auth.uid()-based policies with anon+authenticated open policies
to match the pattern used by all other tables (piezas, conversaciones, etc.).
*/
DROP POLICY IF EXISTS "select_own_analisis_visual" ON analisis_visual;
DROP POLICY IF EXISTS "insert_own_analisis_visual" ON analisis_visual;
DROP POLICY IF EXISTS "update_own_analisis_visual" ON analisis_visual;
DROP POLICY IF EXISTS "delete_own_analisis_visual" ON analisis_visual;

CREATE POLICY "anon_select_analisis_visual" ON analisis_visual FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "anon_insert_analisis_visual" ON analisis_visual FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "anon_update_analisis_visual" ON analisis_visual FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_delete_analisis_visual" ON analisis_visual FOR DELETE
  TO anon, authenticated USING (true);
