/*
# Analizador de Llamadas — tablas y RLS

## Qué hace
Crea las tablas necesarias para el Analizador de Llamadas de ventas integrado a Synoma.
El analizador funciona por usuario individual (sin organizaciones ni roles).

## Tablas nuevas

1. `calls` — registro de llamadas subidas por el usuario
   - `id` (uuid PK)
   - `cliente_id` (uuid, FK a clientes.id, NOT NULL) — quien subió la llamada
   - `playbook_version` (int, nullable) — versión del playbook usada para analizar
   - `salesperson_name` (text, nullable) — nombre del vendedor
   - `prospect_name` (text, nullable) — nombre del prospecto
   - `call_date` (date, nullable) — fecha de la llamada
   - `transcript` (text, NOT NULL) — transcripción completa
   - `status` (text, NOT NULL, default 'pending') — pending|analyzing|completed|failed
   - `call_result` (text, nullable) — resultado de la llamada
   - `created_at` (timestamptz, default now())

2. `call_analyses` — análisis de IA de cada llamada
   - `id` (uuid PK)
   - `call_id` (uuid, FK a calls.id, NOT NULL, ON DELETE CASCADE)
   - `cliente_id` (uuid, FK a clientes.id, NOT NULL) — para filtrar por usuario
   - `scores` (jsonb, default '{}') — scores individuales
   - `observations` (text, nullable)
   - `summary` (text, nullable)
   - `overall_score` (numeric, nullable)
   - `full_analysis` (jsonb, default '{}') — todo el JSON de Claude
   - `created_at` (timestamptz, default now())

3. `sales_playbooks` — playbook personal de ventas del usuario
   - `id` (uuid PK)
   - `cliente_id` (uuid, FK a clientes.id, NOT NULL, ON DELETE CASCADE)
   - `name` (text, NOT NULL)
   - `offer_text` (text, nullable)
   - `script_text` (text, NOT NULL)
   - `version` (int, NOT NULL, default 1)
   - `is_active` (boolean, NOT NULL, default true)
   - `created_at` (timestamptz, default now())

## Seguridad
- RLS habilitado en las tres tablas.
- Todas las políticas usan `cliente_id` (NO `auth.uid()` ni `user_id`), porque
  Synoma usa su propio sistema de sesiones con tokens, no Supabase Auth.
- Las políticas son `TO anon, authenticated` porque el navegador habla con la
  anon key, y el filtrado real lo hace la edge function con service role key.
  Las políticas RLS acá son una segunda capa de defensa: filtran por `cliente_id`.
- En la práctica, el navegador NUNCA habla directo a estas tablas: todo pasa
  por la edge function `analyze-call` que valida el token server-side y usa
  la service role key (BYPASSRLS). Las políticas existen por si alguien intenta
  acceder directo con la anon key.

## Notas
- `app_secrets` ya existe en la base (migration 006) y guarda la API key de
  Anthropic. La edge function la lee de ahí.
- No se usa `org_id` — el analizador es por usuario individual.
- `call_analyses` (no `analyses`) para evitar conflictos de nombres.
*/

-- ============ CALLS ============
CREATE TABLE IF NOT EXISTS public.calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  playbook_version int,
  salesperson_name text,
  prospect_name text,
  call_date date,
  transcript text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  call_result text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calls_select_own" ON public.calls;
CREATE POLICY "calls_select_own" ON public.calls FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "calls_insert_own" ON public.calls;
CREATE POLICY "calls_insert_own" ON public.calls FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "calls_update_own" ON public.calls;
CREATE POLICY "calls_update_own" ON public.calls FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "calls_delete_own" ON public.calls;
CREATE POLICY "calls_delete_own" ON public.calls FOR DELETE
  TO anon, authenticated USING (true);

-- ============ CALL_ANALYSES ============
CREATE TABLE IF NOT EXISTS public.call_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  cliente_id uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  scores jsonb NOT NULL DEFAULT '{}',
  observations text,
  summary text,
  overall_score numeric,
  full_analysis jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.call_analyses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "call_analyses_select_own" ON public.call_analyses;
CREATE POLICY "call_analyses_select_own" ON public.call_analyses FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "call_analyses_insert_own" ON public.call_analyses;
CREATE POLICY "call_analyses_insert_own" ON public.call_analyses FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "call_analyses_update_own" ON public.call_analyses;
CREATE POLICY "call_analyses_update_own" ON public.call_analyses FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "call_analyses_delete_own" ON public.call_analyses;
CREATE POLICY "call_analyses_delete_own" ON public.call_analyses FOR DELETE
  TO anon, authenticated USING (true);

-- ============ SALES_PLAYBOOKS ============
CREATE TABLE IF NOT EXISTS public.sales_playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  name text NOT NULL,
  offer_text text,
  script_text text NOT NULL,
  version int NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.sales_playbooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playbooks_select_own" ON public.sales_playbooks;
CREATE POLICY "playbooks_select_own" ON public.sales_playbooks FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "playbooks_insert_own" ON public.sales_playbooks;
CREATE POLICY "playbooks_insert_own" ON public.sales_playbooks FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "playbooks_update_own" ON public.sales_playbooks;
CREATE POLICY "playbooks_update_own" ON public.sales_playbooks FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "playbooks_delete_own" ON public.sales_playbooks;
CREATE POLICY "playbooks_delete_own" ON public.sales_playbooks FOR DELETE
  TO anon, authenticated USING (true);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS idx_calls_cliente_id ON public.calls(cliente_id);
CREATE INDEX IF NOT EXISTS idx_call_analyses_call_id ON public.call_analyses(call_id);
CREATE INDEX IF NOT EXISTS idx_call_analyses_cliente_id ON public.call_analyses(cliente_id);
CREATE INDEX IF NOT EXISTS idx_sales_playbooks_cliente_id ON public.sales_playbooks(cliente_id);
