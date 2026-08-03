// Synoma Founders — limpieza diaria
//
// Función programada de Netlify: corre sola una vez por día, nadie la llama.
//
// Existe porque el esquema promete cosas que sin esto no se cumplen solas:
//
//   · "las conversaciones se borran a los 90 días". Una promesa de retención que
//     nadie ejecuta es peor que no haberla hecho: el dato sigue ahí igual, y
//     además con la creencia de que no.
//   · Las sesiones vencidas y los códigos usados no sirven para nada y crecen
//     para siempre. Con 100 clientes pidiendo códigos es basura constante.
//
// Todo lo de acá es DELETE de datos ya vencidos. No toca clientes ni perfiles:
// alguien que vuelve a los seis meses tiene que encontrar su identidad intacta.

import { getSql, urlDeBase, faltanTablas } from './_db.js';

const DIAS_RETENCION = Number(process.env.SYNOMA_DIAS_RETENCION) || 90;

export default async () => {
  if (!urlDeBase()) {
    console.warn('[purga] sin base de datos configurada, no hay nada que limpiar');
    return new Response('sin base', { status: 200 });
  }

  const sql = getSql();
  const resumen = {};

  try {
    // 1. Los mensajes viejos. El índice mensajes_creado está para esto.
    const mensajes = await sql`
      DELETE FROM mensajes
      WHERE creado_en < now() - (${DIAS_RETENCION} * INTERVAL '1 day')
      RETURNING id
    `;
    resumen.mensajes = mensajes.length;

    // 2. Las conversaciones que quedaron sin un solo mensaje. Puede pasar porque
    //    la conversación se crea al primer intento y el mensaje recién se guarda
    //    cuando la respuesta terminó: una llamada fallida deja el cascarón.
    const conversaciones = await sql`
      DELETE FROM conversaciones c
      WHERE c.actualizado_en < now() - INTERVAL '1 day'
        AND NOT EXISTS (SELECT 1 FROM mensajes m WHERE m.conversacion_id = c.id)
      RETURNING c.id
    `;
    resumen.conversaciones = conversaciones.length;

    // 3. Sesiones vencidas. Ya no dan acceso (clienteDeSesion filtra por
    //    expira_en), pero ocupan lugar y ensucian cualquier consulta futura.
    const sesiones = await sql`
      DELETE FROM sesiones WHERE expira_en < now() RETURNING id
    `;
    resumen.sesiones = sesiones.length;

    // 4. Códigos usados o vencidos. Se guarda solo el hash, así que no hay nada
    //    sensible, pero son la tabla que más rápido crece.
    const codigos = await sql`
      DELETE FROM codigos_acceso
      WHERE creado_en < now() - INTERVAL '1 day' RETURNING id
    `;
    resumen.codigos = codigos.length;
  } catch (e) {
    if (faltanTablas(e)) {
      console.warn('[purga] las tablas todavía no existen; no hay nada que limpiar');
      return new Response('sin tablas', { status: 200 });
    }
    console.error('[purga] fallo limpiando:', e?.message ?? e);
    return new Response('error', { status: 500 });
  }

  console.log('[purga] listo:', JSON.stringify(resumen));
  return new Response(JSON.stringify(resumen), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Una vez por día. Netlify la ejecuta sola; no hay que configurar nada afuera.
export const config = { schedule: '@daily' };
