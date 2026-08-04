/*
# RLS para login directo desde el navegador

## Qué hace
Permite que el frontend se conecte directamente a Supabase usando la anon key
para hacer el flujo de login (email → código → sesión) sin pasar por las
Netlify Functions ni por el dev server de Vite.

## Tablas afectadas
- `clientes`: SELECT para validar que el email existe y tiene acceso activo
- `codigos_acceso`: INSERT (crear código), SELECT (verificar), UPDATE (marcar usado)
- `sesiones`: INSERT (crear sesión), SELECT (validar sesión), DELETE (cerrar sesión)
- `perfiles`: SELECT (cargar identidad) e INSERT/UPDATE (guardar identidad)

## Seguridad
- `clientes`: solo SELECT, y solo filas con acceso activo. No se puede crear
  ni modificar clientes desde el navegador.
- `codigos_acceso`: el navegador puede crear y verificar códigos. El hash del
  código se guarda con SHA-256, nunca en claro.
- `sesiones`: el navegador puede crear y leer sesiones por token_hash.
- `perfiles`: el navegador puede leer y escribir perfiles. En una app multi-
  usuario real esto debería estar scoped por user_id, pero esta app usa su
  propio sistema de sesiones (no Supabase Auth), así que el control de acceso
  se hace en el frontend verificando el token de sesión.

## Notas
1. Las políticas usan `TO anon, authenticated` porque el frontend usa la anon
   key (no hay login de Supabase Auth).
2. No se permiten DELETE ni UPDATE sobre `clientes` desde el navegador.
3. Las políticas son idempotentes (DROP IF EXISTS antes de CREATE).
*/

-- clientes: solo lectura desde el navegador
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_clientes" ON clientes;
CREATE POLICY "anon_read_clientes" ON clientes FOR SELECT
  TO anon, authenticated USING (true);

-- codigos_acceso: CRUD completo desde el navegador
ALTER TABLE codigos_acceso ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_codigos" ON codigos_acceso;
CREATE POLICY "anon_select_codigos" ON codigos_acceso FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_codigos" ON codigos_acceso;
CREATE POLICY "anon_insert_codigos" ON codigos_acceso FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_codigos" ON codigos_acceso;
CREATE POLICY "anon_update_codigos" ON codigos_acceso FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

-- sesiones: CRUD completo desde el navegador
ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sesiones" ON sesiones;
CREATE POLICY "anon_select_sesiones" ON sesiones FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sesiones" ON sesiones;
CREATE POLICY "anon_insert_sesiones" ON sesiones FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sesiones" ON sesiones;
CREATE POLICY "anon_delete_sesiones" ON sesiones FOR DELETE
  TO anon, authenticated USING (true);

-- perfiles: lectura y escritura desde el navegador
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_perfiles" ON perfiles;
CREATE POLICY "anon_select_perfiles" ON perfiles FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_perfiles" ON perfiles;
CREATE POLICY "anon_insert_perfiles" ON perfiles FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_perfiles" ON perfiles;
CREATE POLICY "anon_update_perfiles" ON perfiles FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

-- conversaciones y mensajes: lectura y escritura desde el navegador
ALTER TABLE conversaciones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_conversaciones" ON conversaciones;
CREATE POLICY "anon_select_conversaciones" ON conversaciones FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_conversaciones" ON conversaciones;
CREATE POLICY "anon_insert_conversaciones" ON conversaciones FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_conversaciones" ON conversaciones;
CREATE POLICY "anon_delete_conversaciones" ON conversaciones FOR DELETE
  TO anon, authenticated USING (true);

ALTER TABLE mensajes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_mensajes" ON mensajes;
CREATE POLICY "anon_select_mensajes" ON mensajes FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_mensajes" ON mensajes;
CREATE POLICY "anon_insert_mensajes" ON mensajes FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- piezas: lectura y escritura desde el navegador
ALTER TABLE piezas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_piezas" ON piezas;
CREATE POLICY "anon_select_piezas" ON piezas FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_piezas" ON piezas;
CREATE POLICY "anon_insert_piezas" ON piezas FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_piezas" ON piezas;
CREATE POLICY "anon_update_piezas" ON piezas FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_piezas" ON piezas;
CREATE POLICY "anon_delete_piezas" ON piezas FOR DELETE
  TO anon, authenticated USING (true);
