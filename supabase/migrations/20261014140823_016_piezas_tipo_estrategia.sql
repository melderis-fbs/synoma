/*
# Permitir el tipo "estrategia" en piezas

1. Tablas modificadas
- `piezas`: la regla que limita los valores de `tipo` ahora acepta tambien 'estrategia'.

2. Motivo
- El servidor clasifica como 'estrategia' las piezas que mencionan "Acto 1/2", "mensaje central",
  "percepcion inicial/final", etc. (tanto al guardar a mano como con /estrategia), pero la regla no
  incluia ese valor y la base rechazaba el guardado.

3. Notas importantes
1. Solo se amplia la lista de valores permitidos; no se modifica ni borra ningun dato.
2. Seguridad (RLS y politicas) sin cambios.
*/

ALTER TABLE piezas DROP CONSTRAINT IF EXISTS piezas_tipo_check;
ALTER TABLE piezas ADD CONSTRAINT piezas_tipo_check CHECK (tipo = ANY (ARRAY[
  'plan','idea','reel','historia','venta','post','reciclado','revision','cicloventa','estrategia','otro'
]));