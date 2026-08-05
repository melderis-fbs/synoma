/*
# RLS lockdown — zero trust from the browser

## Problema
Las políticas anteriores usaban USING(true) en todas las tablas, lo que
significa que cualquier persona con la anon key (embebida en el HTML) podía
leer, modificar y borrar los datos de TODOS los clientes. Además, la tabla
config exponía la API key de Anthropic.

## Solución
- Quitar TODAS las políticas que dejan pasar a anon/authenticated.
- El browser ya NO habla directo a la base: todo pasa por la edge function
  synoma-chat, que usa la SERVICE ROLE key (BYPASSRLS) y valida la sesión
  server-side.
- La única excepción es clientes: SELECT solo para filas con acceso activo,
  para que el login pueda verificar si el email existe. El resto se bloquea.
*/

-- config: NADIE lee la API key desde el navegador
DROP POLICY IF EXISTS "anon_read_config" ON config;
-- Sin política de SELECT para anon/authenticated = bloqueada.

-- clientes: SELECT solo para login (verificar email). Nada de INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "anon_read_clientes" ON clientes;
CREATE POLICY "anon_read_clientes_login" ON clientes FOR SELECT
  TO anon, authenticated USING (acceso = 'activo');

-- codigos_acceso: el navegador solo puede INSERTAR (pedir código) y SELECT
-- (verificar). No puede hacer UPDATE arbitrario.
-- El UPDATE para marcar como usado se hace ahora desde la edge function.
DROP POLICY IF EXISTS "anon_select_codigos" ON codigos_acceso;
CREATE POLICY "anon_select_codigos" ON codigos_acceso FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_codigos" ON codigos_acceso;
CREATE POLICY "anon_insert_codigos" ON codigos_acceso FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_codigos" ON codigos_acceso;
-- Sin política de UPDATE para anon = el navegador no puede modificar códigos.

-- sesiones: el navegador puede INSERT (crear sesión al loguear) y SELECT
-- (validar sesión al cargar la página). No puede DELETE ni UPDATE.
DROP POLICY IF EXISTS "anon_select_sesiones" ON sesiones;
CREATE POLICY "anon_select_sesiones" ON sesiones FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sesiones" ON sesiones;
CREATE POLICY "anon_insert_sesiones" ON sesiones FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sesiones" ON sesiones;
-- Sin política de DELETE para anon = el navegador no puede borrar sesiones.

-- perfiles: BLOQUEADO desde el navegador. Se gestiona desde la edge function.
DROP POLICY IF EXISTS "anon_select_perfiles" ON perfiles;
DROP POLICY IF EXISTS "anon_insert_perfiles" ON perfiles;
DROP POLICY IF EXISTS "anon_update_perfiles" ON perfiles;

-- conversaciones: BLOQUEADO desde el navegador.
DROP POLICY IF EXISTS "anon_select_conversaciones" ON conversaciones;
DROP POLICY IF EXISTS "anon_insert_conversaciones" ON conversaciones;
DROP POLICY IF EXISTS "anon_delete_conversaciones" ON conversaciones;

-- mensajes: BLOQUEADO desde el navegador.
DROP POLICY IF EXISTS "anon_select_mensajes" ON mensajes;
DROP POLICY IF EXISTS "anon_insert_mensajes" ON mensajes;

-- piezas: BLOQUEADO desde el navegador.
DROP POLICY IF EXISTS "anon_select_piezas" ON piezas;
DROP POLICY IF EXISTS "anon_insert_piezas" ON piezas;
DROP POLICY IF EXISTS "anon_update_piezas" ON piezas;
DROP POLICY IF EXISTS "anon_delete_piezas" ON piezas;

-- uso_diario: BLOQUEADO desde el navegador (ya no tenía políticas, pero por seguridad).
