/*
# Tabla de ciclos de estrategia de contenido (15 días)

1. Nueva tabla: `ciclos_estrategia`
   - `id` (uuid, pk)
   - `cliente_id` (uuid, fk a clientes, cascade on delete)
   - `mensaje_central` (text) — la idea de posicionamiento del ciclo
   - `percepcion_inicial` (text) — qué piensa hoy la audiencia
   - `percepcion_final` (text) — qué queremos que piense después
   - `ideas_repetir` (text) — 3 ideas a repetir (separadas por \n)
   - `no_publicar` (text) — contenido que debilitaría el posicionamiento
   - `dias` (jsonb) — los 15 días con todo su detalle, marcados por acto
   - `acto1` (jsonb) — días 1-7 en formato estructurado
   - `acto2` (jsonb) — días 8-15 en formato estructurado
   - `numero_ciclo` (int) — 1 o 2 (primer o segundo ciclo del mes)
   - `fecha_inicio` (date) — fecha de inicio del ciclo
   - `fecha_fin` (date) — fecha de fin (inicio + 14 días)
   - `estado` (text) — 'activo', 'completado', 'abandonado' (default 'activo')
   - `regeneracion` (boolean, default false) — si fue una regeneración del ciclo 1
   - `creado_en` (timestamptz, default now())
   - `actualizado_en` (timestamptz, default now())

2. Seguridad
   - RLS habilitada
   - Policies owner-scoped TO authenticated (la app tiene login)
   - `cliente_id` con DEFAULT auth.uid() no aplica acá porque cliente_id != auth.users.id
   - Las políticas usan EXISTS check contra sesiones/clientes

3. Índices
   - `ciclos_estrategia_cliente_id_idx` para queries por cliente
   - `ciclos_estrategia_estado_idx` para buscar ciclo activo
*/

CREATE TABLE IF NOT EXISTS ciclos_estrategia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  mensaje_central text,
  percepcion_inicial text,
  percepcion_final text,
  ideas_repetir text,
  no_publicar text,
  dias jsonb,
  acto1 jsonb,
  acto2 jsonb,
  numero_ciclo int NOT NULL DEFAULT 1,
  fecha_inicio date,
  fecha_fin date,
  estado text NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','completado','abandonado')),
  regeneracion boolean NOT NULL DEFAULT false,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ciclos_estrategia ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS ciclos_estrategia_cliente_id_idx ON ciclos_estrategia(cliente_id);
CREATE INDEX IF NOT EXISTS ciclos_estrategia_estado_idx ON ciclos_estrategia(estado);

-- Las políticas usan el cliente_id directamente. La edge function usa service role
-- (BYPASSRLS), así que estas políticas son para acceso directo desde el frontend
-- si fuera necesario. En la práctica, la edge function maneja todo.
DROP POLICY IF EXISTS "select_own_ciclos" ON ciclos_estrategia;
CREATE POLICY "select_own_ciclos" ON ciclos_estrategia FOR SELECT
  TO authenticated USING (cliente_id IN (
    SELECT id FROM clientes WHERE email = (auth.jwt() ->> 'email')
  ));

DROP POLICY IF EXISTS "insert_own_ciclos" ON ciclos_estrategia;
CREATE POLICY "insert_own_ciclos" ON ciclos_estrategia FOR INSERT
  TO authenticated WITH CHECK (cliente_id IN (
    SELECT id FROM clientes WHERE email = (auth.jwt() ->> 'email')
  ));

DROP POLICY IF EXISTS "update_own_ciclos" ON ciclos_estrategia;
CREATE POLICY "update_own_ciclos" ON ciclos_estrategia FOR UPDATE
  TO authenticated USING (cliente_id IN (
    SELECT id FROM clientes WHERE email = (auth.jwt() ->> 'email')
  )) WITH CHECK (cliente_id IN (
    SELECT id FROM clientes WHERE email = (auth.jwt() ->> 'email')
  ));

DROP POLICY IF EXISTS "delete_own_ciclos" ON ciclos_estrategia;
CREATE POLICY "delete_own_ciclos" ON ciclos_estrategia FOR DELETE
  TO authenticated USING (cliente_id IN (
    SELECT id FROM clientes WHERE email = (auth.jwt() ->> 'email')
  ));
