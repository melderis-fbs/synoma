-- 1. Sacar el constraint viejo (permite guion/gancho pero no reel/cicloventa)
ALTER TABLE public.piezas DROP CONSTRAINT piezas_tipo_check;

-- 2. Migrar datos: guion y gancho pasan a reel
UPDATE public.piezas SET tipo = 'reel' WHERE tipo IN ('guion','gancho');

-- 3. Agregar el constraint nuevo con los tipos correctos
ALTER TABLE public.piezas ADD CONSTRAINT piezas_tipo_check
  CHECK (tipo = ANY (ARRAY['plan','idea','reel','historia','venta','post','reciclado','revision','cicloventa','otro']));
