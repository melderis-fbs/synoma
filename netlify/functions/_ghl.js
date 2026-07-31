// Synoma Founders — consulta a GHL
//
// GHL es la fuente de verdad de quién tiene acceso. Acá solo se pregunta:
// "¿este email tiene el tag de acceso?".
//
// El diseño importante: NO se pregunta "¿es miembro de Founders?" sino
// "¿tiene el tag synoma-activo?". La diferencia decide si alguien que termina
// el programa puede seguir pagando una suscripción o queda afuera por diseño.
//
// Variables de entorno:
//   GHL_TOKEN        Private Integration de GHL, con permiso de lectura de contactos
//   GHL_LOCATION_ID  el id de la subcuenta
//   GHL_ACTIVE_TAG   el tag que habilita el acceso. Default: synoma-activo
//
// El tag va como variable y no fijo en el código para que se pueda renombrar en
// GHL sin tocar ni publicar código.

const API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export const TAG_ACTIVO = () =>
  (process.env.GHL_ACTIVE_TAG || 'synoma-activo').trim().toLowerCase();

export function ghlConfigurado() {
  return Boolean(process.env.GHL_TOKEN && process.env.GHL_LOCATION_ID);
}

// Devuelve una de tres formas:
//   { estado: 'activo',    contacto }  → tiene el tag
//   { estado: 'sin_tag',   contacto }  → existe en GHL pero sin el tag (ex cliente)
//   { estado: 'no_existe' }            → no está en GHL
//   { estado: 'error', motivo }        → no se pudo consultar
//
// Se distinguen 'sin_tag' y 'no_existe' a propósito: el primero es alguien que
// fue cliente y puede renovar, el segundo es alguien que se equivocó de email.
// Merecen mensajes distintos.
export async function buscarContacto(email) {
  if (!ghlConfigurado()) {
    return { estado: 'error', motivo: 'ghl_sin_configurar' };
  }

  const url = new URL(`${API}/contacts/`);
  url.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
  url.searchParams.set('query', email);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GHL_TOKEN}`,
        Version: VERSION,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[ghl] fallo de red:', e?.message ?? e);
    return { estado: 'error', motivo: 'red' };
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    console.error(`[ghl] respuesta ${res.status}:`, detalle.slice(0, 300));
    return { estado: 'error', motivo: `http_${res.status}` };
  }

  let datos;
  try {
    datos = await res.json();
  } catch {
    return { estado: 'error', motivo: 'json_invalido' };
  }

  const contactos = Array.isArray(datos?.contacts) ? datos.contacts : [];

  // La búsqueda por query es difusa: puede devolver coincidencias parciales.
  // Se exige el email exacto para no darle el acceso de una persona a otra.
  const objetivo = email.toLowerCase();
  const contacto = contactos.find((c) => String(c?.email ?? '').toLowerCase() === objetivo);

  if (!contacto) return { estado: 'no_existe' };

  const tags = (Array.isArray(contacto.tags) ? contacto.tags : [])
    .map((t) => String(t).trim().toLowerCase());

  const limpio = {
    id: contacto.id ?? null,
    email: contacto.email ?? email,
    nombre: [contacto.firstName, contacto.lastName].filter(Boolean).join(' ') || null,
    tags,
  };

  return tags.includes(TAG_ACTIVO())
    ? { estado: 'activo', contacto: limpio }
    : { estado: 'sin_tag', contacto: limpio };
}
