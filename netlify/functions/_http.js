// Synoma Founders — envoltorio de último recurso para los endpoints
//
// Si un handler tira una excepción que no previmos, Netlify devuelve su propia
// página de error, que NO es JSON. El navegador entonces no puede leer ni el
// código ni el mensaje, y le muestra al cliente algo genérico —indistinguible de
// un wifi caído— mientras del lado del servidor no queda rastro de nada.
//
// Eso ya pasó en este proyecto y costó dos rondas de diagnóstico a ciegas. Con
// esto, cualquier falla imprevista sale como JSON con su código, y el stack
// completo queda en el log de la función.

export function blindar(nombre, handler) {
  return async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      console.error(`[${nombre}] EXCEPCIÓN NO PREVISTA:`, e?.stack ?? e?.message ?? e);
      return new Response(JSON.stringify({
        error: 'error_interno',
        message: 'Algo se rompió de nuestro lado. Ya quedó registrado — probá de nuevo en un minuto.',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  };
}
