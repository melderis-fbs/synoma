// Synoma Founders — envío del código por email
//
// Usa Resend. Variables de entorno:
//   RESEND_API_KEY   la clave de resend.com
//   EMAIL_REMITENTE  ej. Synoma <hola@foundersbs.com>  (dominio verificado)
//
// Si RESEND_API_KEY no está cargada, el código se escribe en el log de la
// función en lugar de enviarse. Eso permite probar todo el login antes de tener
// el email configurado: se lee el código en Netlify → Logs → Functions.
//
// Es un modo de desarrollo y avisa fuerte en el log. Con clientes reales
// RESEND_API_KEY tiene que estar cargada.

import { LIMITES } from './_auth.js';

const API = 'https://api.resend.com/emails';

export function emailConfigurado() {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function enviarCodigo(email, codigo) {
  if (!emailConfigurado()) {
    console.warn('');
    console.warn('[email] ─────────────────────────────────────────────');
    console.warn('[email] MODO DESARROLLO: no hay RESEND_API_KEY.');
    console.warn(`[email] El código para ${email} es: ${codigo}`);
    console.warn('[email] Con clientes reales esto NO puede quedar así.');
    console.warn('[email] ─────────────────────────────────────────────');
    console.warn('');
    return { ok: true, modo: 'log' };
  }

  const remitente = process.env.EMAIL_REMITENTE || 'Synoma <onboarding@resend.dev>';

  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: remitente,
        to: [email],
        subject: `${codigo} es tu código de acceso a Synoma`,
        html: plantilla(codigo),
        text: `Tu código de acceso a Synoma es ${codigo}. Vence en 10 minutos.`,
      }),
    });
  } catch (e) {
    console.error('[email] fallo de red:', e?.message ?? e);
    return { ok: false, motivo: 'red' };
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    console.error(`[email] Resend respondió ${res.status}:`, detalle.slice(0, 300));
    return { ok: false, motivo: `http_${res.status}` };
  }

  return { ok: true, modo: 'enviado' };
}

// El código va también en el asunto: así se puede leer desde la notificación del
// teléfono sin abrir el mail. Ahorra el paso más molesto del login.
function plantilla(codigo) {
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#FAFAF8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:1px solid #E6E1DA;border-radius:16px;overflow:hidden">
        <tr><td style="background:#111;padding:22px 28px">
          <div style="color:#fff;font-weight:900;font-size:20px;letter-spacing:.01em">SYN<span style="color:#C4B49A">O</span>MA</div>
        </td></tr>
        <tr><td style="padding:32px 28px 8px">
          <div style="font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:#A8946F;font-weight:700">Tu código de acceso</div>
          <div style="font-size:42px;font-weight:800;letter-spacing:.16em;color:#111;margin:18px 0 6px;font-variant-numeric:tabular-nums">${codigo}</div>
          <p style="color:#7A7A7A;font-size:14px;line-height:1.6;margin:14px 0 0">
            Vence en 10 minutos y sirve una sola vez. Después de usarlo quedás
            dentro por ${LIMITES.DIAS_SESION} días sin volver a pedir código.
          </p>
          <p style="color:#9A9A9A;font-size:12.5px;line-height:1.6;margin:20px 0 0">
            Si no pediste este código, ignorá este mail: sin él nadie puede entrar
            a tu cuenta.
          </p>
        </td></tr>
        <tr><td style="padding:24px 28px 30px">
          <div style="border-top:1px solid #EFEBE4;padding-top:16px;color:#9A9A9A;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">
            Founders · Business Strategists
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
