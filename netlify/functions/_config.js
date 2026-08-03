// Synoma Founders — configuración pública
//
// Lo que el navegador necesita saber y no es secreto. Va por variables de
// entorno para poder cambiar el precio o el destino del pago sin publicar
// código nuevo.
//
//   PRECIO_MENSUAL   número, sin símbolo. Default 59.
//   MONEDA           default USD.
//   RENOVACION_URL   link de pago, WhatsApp o formulario. Vacío = sin botón.
//
// El precio se le muestra al cliente mientras lo tiene incluido, tachado. No es
// decoración: si nunca ve que la herramienta vale algo, el día que se le pide
// que la pague la percibe como un cobro nuevo en lugar de como la continuidad
// de algo que ya venía usando.

export function configPublica() {
  return {
    precio: String(process.env.PRECIO_MENSUAL || '59').trim(),
    moneda: String(process.env.MONEDA || 'USD').trim(),
    renovacion_url: process.env.RENOVACION_URL || null,
  };
}
