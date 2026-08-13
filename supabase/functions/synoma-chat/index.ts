import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SYSTEM_BASE } from "./_prompt.ts";
import { CONOCIMIENTO } from "./_conocimiento.ts";
import { VICKY_SYSTEM } from "./_vicky.ts";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = Number(Deno.env.get("SYNOMA_MAX_TOKENS")) || 8000;
const DEADLINE_MS = Number(Deno.env.get("SYNOMA_DEADLINE_MS")) || 45000;
const MS_PARA_REINTENTAR = Number(Deno.env.get("SYNOMA_MS_REINTENTO")) || 35000;
const MAX_CHARS_MENSAJE = 20000;
const DEFAULT_DAILY_LIMIT = 60;
const MENSAJES_CONTEXTO = 24;
const MAX_CHARS_CONTEXTO = 40000;
const DIAS_SESION = 120;
const MINUTOS_CODIGO = 10;
const MAX_INTENTOS = 5;
const MAX_PEDIDOS_HORA = 5;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// --- Supabase REST helper (service role — BYPASSRLS) ---
// Uses SERVICE_ROLE_KEY so the server can read/write all tables regardless of RLS.
// The browser never uses this key — it only sends its session token.

async function sbSelect(table: string, query: string, filter: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?select=${encodeURIComponent(query)}&${filter}`;
  const res = await fetch(url, {
    headers: {
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
  });
  if (!res.ok) throw new Error(`sb select ${table}: ${res.status}`);
  return res.json();
}

async function sbInsert(table: string, body: Record<string, unknown>) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sb insert ${table}: ${res.status}`);
  return res.json();
}

async function sbUpdate(table: string, body: Record<string, unknown>, filter: string) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sb update ${table}: ${res.status}`);
  return res.json();
}

async function sbDelete(table: string, filter: string) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: {
      apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
  });
  if (!res.ok) throw new Error(`sb delete ${table}: ${res.status}`);
}

// --- Hash (SHA-256, matches the frontend) ---
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Session validation ---
// Returns the client record if the token is valid and the session hasn't expired.
// This is the ONLY way the server trusts a request — the browser sends a token,
// the server hashes it and looks up the session. No cliente_id from the body.
async function validarSesion(token: string): Promise<{ id: string; email: string; nombre: string | null } | null> {
  if (!token) return null;
  const tokenHash = await sha256(token);
  const rows = await sbSelect("sesiones", "cliente_id", `token_hash=eq.${tokenHash}&expira_en=gt.${new Date().toISOString()}&limit=1`);
  if (!rows || rows.length === 0) return null;
  const clienteId = rows[0].cliente_id;
  const clientes = await sbSelect("clientes", "id,email,nombre,acceso", `id=eq.${clienteId}&limit=1`);
  if (!clientes || clientes.length === 0) return null;
  const c = clientes[0];
  if (c.acceso !== "activo") return null;
  // Fire-and-forget: update last use
  sbUpdate("sesiones", { ultimo_uso_en: new Date().toISOString() }, `token_hash=eq.${tokenHash}`).catch(() => {});
  sbUpdate("clientes", { ultimo_acceso_en: new Date().toISOString() }, `id=eq.${clienteId}`).catch(() => {});
  return { id: c.id, email: c.email, nombre: c.nombre };
}

// --- Profile block for the model ---
function bloqueDePerfil(perfil: any) {
  const p = perfil || {};
  const parte = (v: string, vacio: string) => {
    const s = String(v ?? "").trim();
    return s || vacio;
  };
  return [
    "=== PERFIL DEL CLIENTE (su identidad — usala en TODO) ===",
    "--- SUS BASES (las 8 que definen su marca) ---",
    parte(p.fundacion, "(no cargada — si te hace falta un bloque, pedíselo, y ofrecele el comando /fundacion)"),
    "--- SU MANUAL DE TRANSFORMACIÓN ---",
    parte(p.manual, "(no cargado — pedile que lo cargue en \"Mi identidad\")"),
    "--- SU OFERTA EN UNA PÁGINA ---",
    parte(p.oferta, "(no cargada)"),
    "--- FRASES TEXTUALES DE SU ENCUESTA ---",
    parte(p.encuesta, "(no cargadas)"),
    "=== FIN DEL PERFIL ===",
    "Lo de arriba es TODO lo que sabés del cliente. Antes de escribir una sola palabra, repasaste su perfil. Si tu respuesta no se ancla en algo de acá, estás escribiendo genérico.",
  ].join("\n");
}

function bloqueDeFecha(ahora = new Date()) {
  const zona = "America/Argentina/Buenos_Aires";
  let partes: string, iso: string;
  try {
    partes = new Intl.DateTimeFormat("es-AR", {
      timeZone: zona, weekday: "long", day: "numeric", month: "long", year: "numeric",
    }).format(ahora);
    iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(ahora);
  } catch {
    iso = ahora.toISOString().slice(0, 10);
    partes = iso;
  }
  return [
    "=== HOY ===",
    `Hoy es ${partes} (${iso}).`,
    "Usá esta fecha para cualquier cuenta de días, plazo o calendario. NUNCA le preguntes al cliente qué día es: ya lo sabés.",
    "=== FIN ===",
  ].join("\n");
}

// --- Biblioteca helpers ---
const COMANDOS_PIEZA = ["semana","idea","reel","historias","venta","post","repurpose","revisar","cicloventa","objecion","quepublico","estrategia"];
const TIPO_PIEZA: Record<string, string> = {
  semana:"plan", idea:"idea", reel:"reel", historia:"historia",
  venta:"venta", post:"post", repurpose:"reciclado", revisar:"revision", cicloventa:"cicloventa", objecion:"otro", quepublico:"plan", estrategia:"estrategia",
};

function detectarPieza(pregunta: string) {
  const cmd = (pregunta.match(/^\/(\S+)/) || [])[1];
  if (!cmd || !COMANDOS_PIEZA.includes(cmd)) return null;
  return { tipo: TIPO_PIEZA[cmd] || "otro", comando: cmd };
}

function extraerTitulo(texto: string, tipo: string) {
  const limpia = texto.replace(/\*\*/g, "").trim();
  const lineas = limpia.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Patrones de título según tipo de pieza
  const patrones: Record<string, RegExp[]> = {
    estrategia: [
      /^mensaje central del ciclo\s*:?\s*["""](.+?)["""]/i,
      /^mensaje central\s*:?\s*["""](.+?)["""]/i,
      /^acto\s*[12]\s*[:·-]\s*(.+)/i,
    ],
    plan: [
      /^acto\s*[12]\s*[:·-]\s*(.+)/i,
      /^d[ií]a\s*1\s*[:·-]?\s*(.+)/i,
    ],
    reel: [
      /^con qu[eé] frase arranca\s*:?\s*(.+)/i,
      /^gancho\s*:?\s*(.+)/i,
      /^d[ií]a\s*\d+\s*[:·-]?\s*(.+)/i,
    ],
    post: [
      /^con qu[eé] frase arranca\s*:?\s*(.+)/i,
      /^gancho\s*:?\s*(.+)/i,
    ],
    venta: [
      /^oferta\s*:?\s*(.+)/i,
      /^propuesta\s*:?\s*(.+)/i,
    ],
    cicloventa: [
      /^ciclo de (?:promoci[oó]n de )?ventas?\s*[:·-]\s*(.+)/i,
      /^semana\s*1\s*[:·-]?\s*(.+)/i,
    ],
  };

  // Buscar título por patrones del tipo
  if (patrones[tipo]) {
    for (const p of patrones[tipo]) {
      for (const l of lineas) {
        const m = l.match(p);
        if (m && m[1]) {
          let t = m[1].trim().replace(/^["""]|["""]$/g, "");
          if (t.length > 80) t = t.slice(0, 77) + "…";
          return t;
        }
      }
    }
  }

  // Fallback: buscar la primera línea que NO sea conversacional
  const conversacional = /^(mir[aá]|ac[aá]|listo|antes de|te arm|ac[aá] te|bueno|che|mir[aeá],|perfecto|dale|ok\b|ya est[aá])/i;
  const etiquetas = /^(t[ií]tulo|d[ií]a|acto|semana|slide|gancho|desarrollo|cierre|cta|objetivo|formato|idea central|qué buscamos|con qu[eé] frase|qu[eé] le pedimos|ejemplo|historia|creencia|percepci[oó]n|mensaje central|3 ideas|qu[eé] no)/i;

  for (const l of lineas) {
    if (conversacional.test(l)) continue;
    if (etiquetas.test(l)) continue;
    if (l.startsWith("|")) continue; // tabla
    if (l.startsWith("---")) continue;
    if (l.startsWith("(") && l.endsWith(")")) continue; // numeración de slide
    if (l.length < 10) continue;
    let t = l.replace(/^#+\s*/, "").trim();
    if (t.length > 80) t = t.slice(0, 77) + "…";
    return t;
  }

  // Último recurso: el nombre del tipo
  const nombres: Record<string, string> = {
    plan: "Plan semanal", idea: "Ideas", reel: "Reel", historia: "Historias",
    venta: "Pieza de venta", post: "Post", reciclado: "Contenido reciclado",
    revision: "Revisión", cicloventa: "Ciclo de Venta", estrategia: "Estrategia del mes",
  };
  return nombres[tipo] || tipo.charAt(0).toUpperCase() + tipo.slice(1);
}

// Limpia el wrapper conversacional de Synoma: saca las líneas de charla
// al principio y al final, dejando solo la pieza de contenido.
function limpiarContenido(texto: string): string {
  const limpia = texto.replace(/\*\*/g, "").trim();
  const lineas = limpia.split("\n").map((l) => l.trim());

  // Marcadores que indican que arranca el contenido real
  const inicioContenido = /^(d[ií]a\s*\d|acto\s*[12]|mensaje central|percepci[oó]n inicial|antes de armar|slide\s*\(|\(|\||objetivo del mes|plan semana|qué promocionar|acción para|tu visual hoy dice|tu cliente ideal necesita|d[oó]nde est[aá] la distancia|lo que ya funciona|cambi[aá] esto primero)/i;

  // Marcadores que indican charla de Synoma (no contenido)
  const esCharla = /^(mir[aá]|ac[aá] te|listo|antes de arm|te arm|bueno|che|mir[aeá],|perfecto|dale|ok\b|ya est[aá]|ac[aá] ten|tom[aá]|empez[aá]mos|arrancamos|lo que arme|esta es|este es|lo que te|como siempre|no te olvides|record[aá]|marc[aá]lo|baj[aá]telo|guardalo|pod[eé]s editar|si quer[eé]s|si te gusta|si no te|cuando lo|despu[eé]s de|una cosa m[aá]s|por [uú]ltimo|avisanos|avisame|contame c[oó]mo|decime qu[eé]|mandame|escribime|pasame)/i;

  // Encontrar el primer índice de contenido real
  let inicio = 0;
  for (let i = 0; i < lineas.length; i++) {
    if (inicioContenido.test(lineas[i])) { inicio = i; break; }
    if (!esCharla.test(lineas[i]) && lineas[i].length > 30 && !lineas[i].endsWith("?")) { inicio = i; break; }
  }

  // Encontrar el último índice de contenido (antes de la charla final)
  let fin = lineas.length;
  for (let i = lineas.length - 1; i >= inicio; i--) {
    if (lineas[i].length === 0) continue;
    if (esCharla.test(lineas[i]) && i > inicio + 3) { fin = i; continue; }
    break;
  }

  const limpio = lineas.slice(inicio, fin).join("\n").trim();
  return limpio.length > 100 ? limpio : limpia;
}

function esClarificacion(respuesta: string): boolean {
  const limpia = respuesta.trim();
  if (limpia.length < 800) return true;
  if (limpia.length < 1500 && limpia.endsWith("?")) return true;
  const primeraLinea = limpia.split("\n")[0].toLowerCase();
  if (limpia.length < 1500 && /^(pasame|decime|para armar|para el|todav\u00eda no|necesito que|cu\u00e1l|decime el)/i.test(primeraLinea)) return true;
  return false;
}

async function guardarSiEsPieza(clienteId: string, pregunta: string, respuesta: string) {
  const det = detectarPieza(pregunta);
  if (!det) return null;
  if (esClarificacion(respuesta)) return null;
  const titulo = extraerTitulo(respuesta, det.tipo);
  const contenido = limpiarContenido(respuesta);
  const rows = await sbInsert("piezas", {
    cliente_id: clienteId, tipo: det.tipo, titulo, contenido, comando: det.comando, estado: "nueva",
  });
  return Array.isArray(rows) ? rows[0] : null;
}

// --- Estrategia: extraer ciclo de la respuesta de Claude ---
// Solo se guarda cuando la respuesta contiene el cierre completo (mensaje central,
// percepciones, 3 ideas a repetir, qué no publicar). Si la respuesta es solo el
// Paso 1 (la idea para aprobar), no se guarda todavía: el ciclo se completa
// cuando el cliente confirma y Claude genera los 15 días.
function extraerCicloEstrategia(respuesta: string): {
  mensaje_central: string;
  percepcion_inicial: string;
  percepcion_final: string;
  ideas_repetir: string;
  no_publicar: string;
  dias: any;
} | null {
  const limpia = respuesta.replace(/\*\*/g, "");
  
  // Buscar mensaje central
  const mMensaje = limpia.match(/mensaje central del ciclo\s*:?\s*["""](.+?)["""]/i)
    || limpia.match(/mensaje central\s*:?\s*["""](.+?)["""]/i);
  if (!mMensaje) return null;

  // Buscar percepción inicial
  const mInicial = limpia.match(/percepci[oó]n inicial\s*:?\s*(.+?)(?=\n\s*percepci|\n\s*mensaje|\n\s*3 ideas|\n\s*qu[eé] no)/is);
  
  // Buscar percepción final
  const mFinal = limpia.match(/percepci[oó]n final\s*:?\s*(.+?)(?=\n\s*mensaje|\n\s*3 ideas|\n\s*qu[eé] no)/is);

  // Buscar 3 ideas a repetir
  const mIdeas = limpia.match(/3 ideas que debemos repetir\s*:?\s*(.+?)(?=\n\s*qu[eé] no|\n\s*===|\Z)/is);

  // Buscar qué no publicar
  const mNoPub = limpia.match(/qu[eé] no debemos publicar\s*:?\s*(.+?)(?=\n\s*===|\n\s*objetivo|\Z)/is);

  // Buscar los días (DÍA 1, DÍA 2, etc.)
  const dias: any[] = [];
  const regexDia = /D[IÍ]A\s*(\d+)\s*\n([\s\S]*?)(?=D[IÍ]A\s*\d+|ACTO\s*2|PERCEPCI|3 IDEAS|QU[EÉ] NO|$)/gi;
  let match;
  while ((match = regexDia.exec(limpia)) !== null) {
    dias.push({
      dia: parseInt(match[1]),
      contenido: match[2].trim(),
    });
  }

  // Si no hay días en la respuesta, no es el cierre completo
  if (dias.length === 0) return null;

  return {
    mensaje_central: mMensaje[1].trim(),
    percepcion_inicial: mInicial ? mInicial[1].trim() : "",
    percepcion_final: mFinal ? mFinal[1].trim() : "",
    ideas_repetir: mIdeas ? mIdeas[1].trim() : "",
    no_publicar: mNoPub ? mNoPub[1].trim() : "",
    dias,
  };
}

// --- Conversation helpers ---
async function conversacionAbierta(clienteId: string, tipo: string = "synoma") {
  const rows = await sbSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&tipo=eq.${tipo}&cerrada_en=is.null&order=actualizado_en.desc&limit=1`);
  if (rows[0]) return rows[0].id;
  const creada = await sbInsert("conversaciones", { cliente_id: clienteId, tipo });
  return Array.isArray(creada) ? creada[0].id : null;
}

async function historialV2(clienteId: string, limite: number, tipo: string = "synoma") {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&tipo=eq.${tipo}&order=actualizado_en.desc&limit=1`);
  if (!convs || convs.length === 0) return [];
  const convId = convs[0].id;
  const msgs = await sbSelect("mensajes", "rol,contenido,creado_en", `conversacion_id=eq.${convId}&order=creado_en.desc&limit=${limite}`);
  return (msgs || []).reverse().map((m: any) => ({ role: m.rol, content: m.contenido }));
}

async function guardarTurno(clienteId: string, pregunta: string, respuesta: string, tipo: string = "synoma") {
  const p = (pregunta || "").slice(0, MAX_CHARS_MENSAJE).trim();
  const r = respuesta.slice(0, MAX_CHARS_MENSAJE).trim();
  if (!r) return;
  const textoGuardar = p || "(archivo adjunto)";
  const convId = await conversacionAbierta(clienteId, tipo);
  await sbInsert("mensajes", { conversacion_id: convId, rol: "user", contenido: textoGuardar });
  await sbInsert("mensajes", { conversacion_id: convId, rol: "assistant", contenido: r });
  await sbUpdate("conversaciones", { actualizado_en: new Date().toISOString(), titulo: textoGuardar.slice(0, 80) }, `id=eq.${convId}`);
}

// Convierte los archivos que manda el navegador en bloques de contenido para
// Claude. Las imágenes y PDFs se suben primero a Supabase Storage (ver
// prepareFiles en el frontend) y acá se descargan con la service role key;
// CSV y Excel se mandan como texto extraído porque Claude no los parsea
// binarios.
async function archivosABloques(archivos: any[]): Promise<any[]> {
  if (!Array.isArray(archivos) || !archivos.length) return [];
  const bloques: any[] = [];
  for (const a of archivos) {
    if (!a || !a.type) continue;
    if ((a.type === "image" || a.type === "pdf") && a.storage_path) {
      const mediaType = a.type === "pdf" ? "application/pdf" : (a.media_type || "image/png");
      const bucket = "chat-attachments";
      const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${bucket}/${a.storage_path}`;
      const res = await fetch(url, {
        headers: {
          apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      if (a.type === "pdf") {
        bloques.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        });
      } else {
        bloques.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64 },
        });
      }
      // Limpiar el archivo del bucket después de descargarlo
      fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${bucket}/${a.storage_path}`, {
        method: "DELETE",
        headers: {
          apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      }).catch(() => {});
    } else if (a.type === "text" && a.content) {
      const etiqueta = a.name ? `=== ARCHIVO: ${a.name} ===\n` : "";
      bloques.push({ type: "text", text: `${etiqueta}${a.content}\n=== FIN DEL ARCHIVO ===` });
    }
  }
  return bloques;
}

async function construirMensajeUsuario(pregunta: string, archivos: any[]): Promise<any> {
  const bloques = await archivosABloques(archivos);
  if (!bloques.length) return pregunta;
  const texto = pregunta || "Te adjunto archivos para que los revises.";
  return [{ type: "text", text }, ...bloques];
}

function paraElModelo(mensajes: any[]) {
  let limpios = mensajes
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const content = m.content;
      // Si el contenido ya es un array (bloques de Claude), lo dejamos como está.
      if (Array.isArray(content)) return { role: m.role, content };
      return { role: m.role, content: String(content || "").slice(0, MAX_CHARS_MENSAJE) };
    })
    .filter((m) => {
      if (Array.isArray(m.content)) return m.content.length > 0;
      return m.content.trim().length > 0;
    });

  let total = 0;
  const dentro: any[] = [];
  for (let i = limpios.length - 1; i >= 0; i--) {
    const c = limpios[i].content;
    const len = Array.isArray(c) ? c.reduce((n: number, b: any) => n + (typeof b.text === "string" ? b.text.length : 1000), 0) : c.length;
    total += len;
    if (total > MAX_CHARS_CONTEXTO && dentro.length > 0) break;
    dentro.unshift(limpios[i]);
  }
  limpios = dentro;

  while (limpios.length && limpios[0].role !== "user") limpios.shift();

  const alternados: any[] = [];
  for (const m of limpios) {
    const anterior = alternados[alternados.length - 1];
    if (anterior && anterior.role === m.role) {
      // Solo fusionar si ambos son texto plano
      if (!Array.isArray(anterior.content) && !Array.isArray(m.content)) {
        anterior.content += `\n\n${m.content}`;
      } else {
        alternados.push({ ...m });
      }
    } else {
      alternados.push({ ...m });
    }
  }
  return alternados;
}

// --- Daily usage check ---
async function usoDeHoy(clienteId: string): Promise<number> {
  const hoy = new Date().toISOString().slice(0, 10);
  const rows = await sbSelect("uso_diario", "mensajes", `cliente_id=eq.${clienteId}&fecha=eq.${hoy}&limit=1`);
  return rows?.[0]?.mensajes || 0;
}

async function incrementarUso(clienteId: string) {
  const hoy = new Date().toISOString().slice(0, 10);
  try {
    await sbUpdate("uso_diario", { mensajes: (await usoDeHoy(clienteId)) + 1 }, `cliente_id=eq.${clienteId}&fecha=eq.${hoy}`);
  } catch {
    await sbInsert("uso_diario", { cliente_id: clienteId, fecha: hoy, mensajes: 1 });
  }
}

// --- Claude streaming ---
async function callClaude(apiKey: string, system: any[], messages: any[], attempt = 0) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, system, messages, output_config: { effort: "low" } }),
  });
  if (res.ok) return res;
  const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
  if (retryable && attempt < 2) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    return callClaude(apiKey, system, messages, attempt + 1);
  }
  const detail = await res.text().catch(() => "");
  throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
}

async function bombearStream(
  cuerpo: ReadableStream<Uint8Array>,
  emit: (obj: any) => void,
  inicioPedido: number,
): Promise<{ resultado: string; emittedText: boolean; respuesta: string; stopReason: string | null }> {
  const reader = cuerpo.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedText = false;
  let respuesta = "";
  let stopReason: string | null = null;

  while (true) {
    if (Date.now() - inicioPedido > DEADLINE_MS) {
      reader.cancel().catch(() => {});
      return { resultado: emittedText ? "tiempo" : "tarde", emittedText, respuesta, stopReason };
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let ev; try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        emittedText = true;
        respuesta += ev.delta.text;
        emit({ type: "text", text: ev.delta.text });
      } else if (ev.type === "message_delta") {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        return { resultado: "error", emittedText, respuesta, stopReason };
      }
    }
  }
  return { resultado: "fin", emittedText, respuesta, stopReason };
}

// --- Route handlers ---

// POST /chat — generate content (streaming)
// POST /login — request access code
// POST /verificar — verify code and create session
// GET  /perfil — get identity
// PUT  /perfil — save identity
// GET  /biblioteca — list pieces
// PATCH /biblioteca — update piece state
// DELETE /biblioteca — delete piece
// GET  /historial — get chat history
// DELETE /historial — clear chat history

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "PATCH" && req.method !== "PUT" && req.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const accion = path.split("/").pop() || "chat";

  // --- LOGIN: pedir código (no requiere sesión) ---
  if (accion === "login" && req.method === "POST") {
    return handleLogin(req);
  }

  // --- VERIFICAR: validar código y crear sesión (no requiere sesión) ---
  if (accion === "verificar" && req.method === "POST") {
    return handleVerificar(req);
  }

  // --- Todo lo demás requiere sesión válida ---
  let token = "";
  const authHeader = req.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7);
  if (!token) {
    const body = await req.clone().json().catch(() => ({}));
    token = String(body?.token || "");
  }

  const cliente = await validarSesion(token);
  if (!cliente) return json({ error: "no_sesion", message: "Tu sesión expiró. Volvé a entrar." }, 401);

  // --- PERFIL ---
  if (accion === "perfil") {
    if (req.method === "GET") return handleGetPerfil(cliente);
    if (req.method === "PUT" || req.method === "POST") return handleSavePerfil(cliente, req);
  }

  // --- BIBLIOTECA ---
  if (accion === "biblioteca") {
    if (req.method === "GET") return handleGetBiblioteca(cliente);
    if (req.method === "POST") return handleSavePiezaManual(cliente, req);
    if (req.method === "PATCH") return handleUpdatePieza(cliente, req);
    if (req.method === "DELETE") return handleDeletePieza(cliente, req);
  }

  // --- HISTORIAL ---
  if (accion === "historial") {
    if (req.method === "GET") return handleGetHistorial(cliente);
    if (req.method === "DELETE") return handleDeleteHistorial(cliente);
  }

  // --- VICKY CHAT ---
  if (accion === "vicky-chat") {
    if (req.method === "GET") return handleGetHistorialVicky(cliente);
    if (req.method === "POST") return handleVickyChat(cliente, req);
    if (req.method === "DELETE") return handleDeleteHistorialVicky(cliente);
  }

  // --- ANÁLISIS VISUAL ---
  if (accion === "analisis-visual") {
    if (req.method === "GET") return handleGetAnalisisVisual(cliente);
    if (req.method === "POST") return handleAnalisisVisual(cliente, req);
  }

  // GET /analisis-visual — listar historial de diagnósticos
async function handleGetAnalisisVisual(cliente: { id: string }) {
  const rows = await sbSelect("analisis_visual", "id,tipo,resultado,imagenes,creado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc&limit=20`);
  return json(rows || []);
}

// POST /analisis-visual — analizar imágenes con visión
async function handleAnalisisVisual(cliente: { id: string }, req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const tipo = payload?.tipo === "chequeo" ? "chequeo" : "diagnostico";
  const archivos = Array.isArray(payload?.archivos) ? payload.archivos : [];
  if (!archivos.length) return json({ error: "sin_imagenes", message: "Subí al menos una imagen." }, 400);
  if (archivos.length > 9) return json({ error: "muchas_imagenes", message: "Máximo 9 imágenes por análisis." }, 400);

  // --- Límites de uso ---
  const ahora = new Date();
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).toISOString();
  const inicioSemana = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const historial = await sbSelect("analisis_visual", "tipo,creado_en", `cliente_id=eq.${cliente.id}&creado_en=gt.${inicioMes}`);
  const diagnosticosMes = (historial || []).filter((h: any) => h.tipo === "diagnostico").length;
  const chequeosSemana = (historial || []).filter((h: any) => h.tipo === "chequeo" && new Date(h.creado_en) >= new Date(inicioSemana)).length;

  if (tipo === "diagnostico" && diagnosticosMes >= 2) {
    const proximoMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1).toLocaleDateString("es-AR", { day: "numeric", month: "long" });
    return json({ error: "limite_alcanzado", message: `Ya usaste tus 2 diagnósticos completos de este mes. Se renuevan el ${proximoMes}.` }, 429);
  }
  if (tipo === "chequeo" && chequeosSemana >= 5) {
    return json({ error: "limite_alcanzado", message: "Ya usaste tus 5 chequeos de esta semana. Se renuevan en 7 días." }, 429);
  }

  // --- Obtener perfil del cliente para contexto ---
  const perfiles = await sbSelect("perfiles", "manual,oferta,encuesta,fundacion", `cliente_id=eq.${cliente.id}&limit=1`);
  const p = perfiles?.[0] || {};

  // --- Construir prompt según tipo ---
  const promptSistema = construirPromptAnalisisVisual(tipo, p);

  // --- Descargar y preparar imágenes ---
  const bloques = await archivosABloques(archivos);
  if (!bloques.length) return json({ error: "error_imagenes", message: "No pude leer las imágenes. Probá subirlas de nuevo." }, 400);

  const mensajeUsuario = tipo === "diagnostico"
    ? "Acá está mi feed. Quiero el diagnóstico completo."
    : "Acá está la placa que voy a publicar. Quiero el chequeo rápido.";

  const messages = [{ role: "user", content: [{ type: "text", text: mensajeUsuario }, ...bloques] }];

  // --- Llamar a Claude (sin streaming, devolvemos el texto completo) ---
  let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "no_api_key", message: "Servicio no configurado." }, 500);

  let respuesta = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: false,
        system: [{ type: "text", text: promptSistema }],
        messages,
      }),
    });
    if (!res.ok) {
 const detail = await res.text().catch(() => "");
      return json({ error: "api_error", message: `Error del servicio de IA (${res.status}).` }, 502);
    }
    const data = await res.json();
    respuesta = (data?.content || []).map((b: any) => b?.text || "").join("");
  } catch {
    return json({ error: "api_error", message: "No pude conectar con el servicio de IA." }, 502);
  }

  if (!respuesta.trim()) return json({ error: "vacio", message: "El análisis no generó resultado. Probá de nuevo." }, 502);

  // --- Guardar en historial ---
  await sbInsert("analisis_visual", {
    cliente_id: cliente.id,
    tipo,
    resultado: respuesta,
    imagenes: archivos.length,
  });

  return json({ ok: true, resultado: respuesta });
}

function construirPromptAnalisisVisual(tipo: string, perfil: any): string {
  const oferta = perfil.oferta?.trim() || "(no cargada)";
  const manual = perfil.manual?.trim() || "(no cargado)";
  const encuesta = perfil.encuesta?.trim() || "(no cargadas)";

  const base = `Sos Synoma, una socia que ayuda a profesionales a crear contenido para redes sociales.
Estás haciendo un ANÁLISIS VISUAL del contenido de Instagram de una clienta.

DATOS DE LA CLIENTA:
- Oferta: ${oferta}
- Manual de marca: ${manual}
- Encuesta de identidad: ${encuesta}

REGLAS OBLIGATORIAS:
1. NUNCA muestres números, notas, porcentajes, estrellas ni barras de calidad. Ni "7/10", ni "nivel intermedio". Prohibido.
2. Un solo cambio prioritario por vez. Aunque veas diez problemas, informá uno: el que más mueva la percepción de precio.
3. Siempre nombrá algo que ya funciona, y que sea real. Nada de elogios genéricos inventados.
4. Sin jerga de diseño. Prohibido: jerarquía tipográfica, kerning, paleta cromática, composición, grilla, contraste tonal. Traducir a lenguaje común.
5. Nunca compares con otras personas. Ni otras clientas, ni referentes, ni influencers.
6. El cambio tiene que ser ejecutable sin diseñador. Unificar tipografía, agrandar texto, sacar palabras. No sugerir rediseños de marca.
7. Si la imagen no se entiende, pedí otra sin culpar a la clienta. Decí "no llego a ver bien las placas, ¿me pasás una captura más grande?" y nunca "subiste mal la imagen".
8. El tono es de socia: directa y honesta, pero nunca dura. Todo en términos de negocio (cuánto puede cobrar, a quién atrae), nunca de gusto personal.

LAS 5 COSAS QUE ANALIZÁS (uso interno, la clienta nunca ve esta lista):
1. Precio percibido — ¿parece de alguien que cobra USD 300 o USD 3.000? Comparar contra el precio real de su oferta. Es el más importante: priorizalo siempre.
2. Coherencia — ¿todas las piezas parecen de la misma persona? Tipografías, colores, estilo.
3. Legibilidad en celular — ¿se lee en pantalla chica? Tamaño de texto, contraste, cantidad de texto por placa.
4. Foco — ¿cada pieza comunica una sola idea o está saturada?
5. Reconocimiento — si se tapara el nombre, ¿se sabría que es esta persona?`;

  if (tipo === "chequeo") {
    return base + `

MOMENTO: Chequeo de una pieza antes de publicar.
Devolvé una versión CORTA: un comentario sobre legibilidad y foco, y si desentona con el resto de su feed. Máximo 4 líneas.
No uses la estructura de 5 partes. Es un chequeo rápido, no un diagnóstico completo.`;
  }

  return base + `

MOMENTO: Diagnóstico completo del feed.
Devolvé la respuesta SIEMPRE con estas cinco partes, en este orden exacto:

TU VISUAL HOY DICE:
[una frase corta describiendo qué comunica su imagen actual]

TU CLIENTE IDEAL NECESITA VER:
[una frase corta describiendo qué debería comunicar, según a quién le vende y a qué precio]

DÓNDE ESTÁ LA DISTANCIA:
[dos o tres oraciones explicando qué está causando la diferencia, señalando elementos visuales concretos]

LO QUE YA FUNCIONA:
[algo real que está haciendo bien y no debería cambiar]

CAMBIÁ ESTO PRIMERO:
[UN SOLO cambio concreto, con el tiempo que le va a llevar]

Si ya existe un diagnóstico anterior en el historial, arrancá comparando en palabras (nunca con números):
"Hace un mes tu visual decía X. Hoy dice Y. Avanzaste." o mostrar de nuevo el cambio pendiente si no hubo mejora.`;
}

// --- CHAT (default) ---
  if (req.method === "POST") return handleChat(cliente, req);

  return json({ error: "not_found" }, 404);
});

// ============ CONFIG HELPERS ============
async function getConfig(clave: string): Promise<string | null> {
  try {
    const rows = await sbSelect("config", "valor", `clave=eq.${clave}&limit=1`);
    return rows?.[0]?.valor || null;
  } catch { return null; }
}

// ============ GHL ============
async function buscarEnGHL(email: string): Promise<{ estado: "activo" | "sin_tag" | "no_existe" | "error"; nombre?: string | null; ghlId?: string | null }> {
  const token = await getConfig("ghl_token");
  const locationId = await getConfig("ghl_location_id");
  if (!token || !locationId) return { estado: "error" };

  const tagActivo = (await getConfig("ghl_active_tag") || "synoma-activo").trim().toLowerCase();
  const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=${encodeURIComponent(email)}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" },
    });
  } catch { return { estado: "error" }; }

  if (!res.ok) return { estado: "error" };
  const datos = await res.json().catch(() => ({}));
  const contactos = Array.isArray(datos?.contacts) ? datos.contacts : [];
  const contacto = contactos.find((c: any) => String(c?.email ?? "").toLowerCase() === email);
  if (!contacto) return { estado: "no_existe" };

  const tags = (Array.isArray(contacto.tags) ? contacto.tags : []).map((t: string) => String(t).trim().toLowerCase());
  const nombre = [contacto.firstName, contacto.lastName].filter(Boolean).join(" ") || null;
  return tags.includes(tagActivo)
    ? { estado: "activo", nombre, ghlId: contacto.id ?? null }
    : { estado: "sin_tag", nombre, ghlId: contacto.id ?? null };
}

// ============ LOGIN ============
async function handleLogin(req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const email = String(payload?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return json({ error: "bad_email", message: "Escribí tu email." }, 400);

  // Rate limit: max 5 pedidos por hora por email
  const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const pedidos = await sbSelect("codigos_acceso", "id", `email=eq.${email}&creado_en=gt.${haceUnaHora}`);
  if (pedidos && pedidos.length >= MAX_PEDIDOS_HORA) {
    return json({ error: "rate_limit", message: "Pediste muchos códigos. Esperá unos minutos." }, 429);
  }

  // --- Acceso directo para el equipo (@foundersbs.com) ----------------------
  // Los coaches y el equipo entran sin código: su identidad es el dominio.
  // Si alguien puede crear una cuenta @foundersbs.com, ya es de confianza.
  if (email.endsWith("@foundersbs.com")) {
    let clientes = await sbSelect("clientes", "id,acceso,nombre", `email=eq.${email}&limit=1`);
    if (!clientes || clientes.length === 0) {
      const creada = await sbInsert("clientes", { email, nombre: null, acceso: "activo", origen_acceso: "manual" });
      clientes = Array.isArray(creada) ? creada : await sbSelect("clientes", "id,acceso,nombre", `email=eq.${email}&limit=1`);
    }
    const c = clientes[0];
    if (c.acceso !== "activo") {
      await sbUpdate("clientes", { acceso: "activo", origen_acceso: "manual" }, `id=eq.${c.id}`);
    }

    const token = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await sha256(token);
    const expira = new Date(Date.now() + DIAS_SESION * 24 * 60 * 60 * 1000).toISOString();
    await sbInsert("sesiones", { cliente_id: c.id, token_hash: tokenHash, expira_en: expira });

    const perfiles = await sbSelect("perfiles", "oferta", `cliente_id=eq.${c.id}&limit=1`);
    const tienePerfil = perfiles?.[0]?.oferta?.trim()?.length > 0;

    return json({
      ok: true,
      acceso_directo: true,
      token,
      cliente: { id: c.id, email: c.email, nombre: c.nombre },
      tiene_perfil: tienePerfil,
    });
  }

  // Verificar que el cliente existe y tiene acceso activo
  let clientes = await sbSelect("clientes", "id,acceso,nombre", `email=eq.${email}&limit=1`);

  // Si no está en la base, consultar GHL (fuente de verdad) y auto-darlo de alta
  if (!clientes || clientes.length === 0) {
    const ghl = await buscarEnGHL(email);
    if (ghl.estado === "activo") {
      await sbInsert("clientes", { email, nombre: ghl.nombre, acceso: "activo", origen_acceso: "founders", ghl_contact_id: ghl.ghlId });
      clientes = await sbSelect("clientes", "id,acceso,nombre", `email=eq.${email}&limit=1`);
    } else if (ghl.estado === "sin_tag") {
      return json({ error: "sin_acceso", message: "Tu acceso a Synoma terminó." }, 403);
    } else if (ghl.estado === "no_existe") {
      return json({ error: "no_encontrado", message: "No encontramos ese email. Revisá que esté bien escrito." }, 404);
    } else {
      return json({ error: "verificacion_no_disponible", message: "No podemos verificar tu acceso en este momento. Probá en unos minutos." }, 503);
    }
  }

  if (!clientes || clientes.length === 0) {
    return json({ error: "no_encontrado", message: "No encontramos ese email. Revisá que esté bien escrito." }, 404);
  }
  if (clientes[0].acceso !== "activo") {
    return json({ error: "sin_acceso", message: "Tu acceso a Synoma terminó." }, 403);
  }

  // Generar código de 6 dígitos (crypto random)
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  const hashCodigo = await sha256(codigo);
  const expira = new Date(Date.now() + MINUTOS_CODIGO * 60 * 1000).toISOString();

  // Invalidar códigos anteriores
  await sbUpdate("codigos_acceso", { usado_en: new Date().toISOString() }, `email=eq.${email}&usado_en=is.null`);

  // Guardar nuevo código
  await sbInsert("codigos_acceso", { email, codigo_hash: hashCodigo, expira_en: expira });

  // Enviar por email si hay Resend configurado, sino devolver el código
  // (en producción el código NO se devuelve al cliente — solo por email)
  const resendKey = Deno.env.get("RESEND_API_KEY") || await getConfig("resend_api_key");
  const remitente = await getConfig("email_remitente") || "Synoma <noreply@synoma.dev>";
  if (resendKey) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: remitente,
          to: email,
          subject: "Tu código de acceso a Synoma",
          text: `Tu código es: ${codigo}\n\nVence en ${MINUTOS_CODIGO} minutos.`,
        }),
      });
    } catch {
      // Si falla el envío, no exponemos el código al cliente
    }
    return json({ ok: true, enviado: true });
  }

  // Sin Resend: en desarrollo devolvemos el código. En producción esto no debería pasar.
  return json({ ok: true, enviado: false, codigo_dev: codigo });
}

// ============ VERIFICAR ============
async function handleVerificar(req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const email = String(payload?.email || "").trim().toLowerCase();
  const codigo = String(payload?.codigo || "").replace(/\D/g, "");
  if (!email || codigo.length !== 6) {
    return json({ error: "bad_data", message: "Faltan datos." }, 400);
  }

  const hashCodigo = await sha256(codigo);
  const rows = await sbSelect("codigos_acceso", "id,expira_en,usado_en,intentos", `email=eq.${email}&codigo_hash=eq.${hashCodigo}&order=creado_en.desc&limit=1`);

  if (!rows || rows.length === 0) {
    return json({ error: "codigo_incorrecto", message: "El código no es correcto." }, 400);
  }

  const reg = rows[0];
  if (reg.usado_en) return json({ error: "usado", message: "Ese código ya se usó." }, 400);
  if (new Date(reg.expira_en) < new Date()) return json({ error: "expirado", message: "El código venció. Pedí uno nuevo." }, 400);
  if (reg.intentos >= MAX_INTENTOS) return json({ error: "demasiados", message: "Demasiados intentos. Pedí un código nuevo." }, 400);

  // Marcar como usado
  await sbUpdate("codigos_acceso", { usado_en: new Date().toISOString() }, `id=eq.${reg.id}`);

  // Buscar cliente
  const clientes = await sbSelect("clientes", "id,email,nombre", `email=eq.${email}&limit=1`);
  if (!clientes || clientes.length === 0) return json({ error: "no_encontrado" }, 404);

  const c = clientes[0];

  // Crear sesión
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256(token);
  const expira = new Date(Date.now() + DIAS_SESION * 24 * 60 * 60 * 1000).toISOString();
  await sbInsert("sesiones", { cliente_id: c.id, token_hash: tokenHash, expira_en: expira });

  // Verificar si tiene perfil cargado
  const perfiles = await sbSelect("perfiles", "oferta", `cliente_id=eq.${c.id}&limit=1`);
  const tienePerfil = perfiles?.[0]?.oferta?.trim()?.length > 0;

  return json({
    ok: true,
    token,
    cliente: { id: c.id, email: c.email, nombre: c.nombre },
    tiene_perfil: tienePerfil,
  });
}

// ============ PERFIL ============
async function handleGetPerfil(cliente: { id: string }) {
  const rows = await sbSelect("perfiles", "manual,oferta,encuesta,fundacion", `cliente_id=eq.${cliente.id}&limit=1`);
  return json({ perfil: rows?.[0] || null });
}

async function handleSavePerfil(cliente: { id: string }, req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const cuerpo = {
    manual: String(payload?.manual || "").trim(),
    oferta: String(payload?.oferta || "").trim(),
    encuesta: String(payload?.encuesta || "").trim(),
    fundacion: String(payload?.fundacion || "").trim(),
  };

  if (!cuerpo.oferta) return json({ error: "sin_oferta", message: "Como mínimo pegá tu Oferta en Una Página." }, 400);

  const existentes = await sbSelect("perfiles", "cliente_id", `cliente_id=eq.${cliente.id}&limit=1`);
  if (existentes?.length) {
    await sbUpdate("perfiles", { ...cuerpo, actualizado_en: new Date().toISOString() }, `cliente_id=eq.${cliente.id}`);
  } else {
    await sbInsert("perfiles", { cliente_id: cliente.id, ...cuerpo });
  }

  return json({ ok: true });
}

// ============ BIBLIOTECA ============
async function handleGetBiblioteca(cliente: { id: string }) {
  const rows = await sbSelect("piezas", "id,tipo,titulo,contenido,estado,creado_en,publicado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc`);
  return json({ piezas: rows || [] });
}

async function handleUpdatePieza(cliente: { id: string }, req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const piezaId = String(payload?.id || "");
  const estado = String(payload?.estado || "");
  const ESTADOS_VALIDOS = ["nueva", "grabada", "publicada", "archivada"];
  if (!piezaId || !ESTADOS_VALIDOS.includes(estado)) return json({ error: "bad_data" }, 400);

  const body: Record<string, unknown> = {
    estado,
    actualizado_en: new Date().toISOString(),
  };
  if (estado === "publicada") body.publicado_en = new Date().toISOString();
  else body.publicado_en = null;

  try {
    await sbUpdate("piezas", body, `id=eq.${piezaId}&cliente_id=eq.${cliente.id}`);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "db_error", message: "No pudimos actualizarla.", detail: String(e?.message || e) }, 500);
  }
}

async function handleDeletePieza(cliente: { id: string }, req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const piezaId = String(payload?.id || "");
  if (!piezaId) return json({ error: "bad_data" }, 400);

  // Scoped al cliente
  await sbDelete("piezas", `id=eq.${piezaId}&cliente_id=eq.${cliente.id}`);
  return json({ ok: true });
}

async function handleSavePiezaManual(cliente: { id: string }, req: Request) {
  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const contenidoCrudo = String(payload?.contenido || "").trim();
  const tipo = String(payload?.tipo || "otro").trim();
  if (!contenidoCrudo) return json({ error: "bad_data", message: "Falta el contenido." }, 400);

  const contenido = limpiarContenido(contenidoCrudo);
  const titulo = String(payload?.titulo || "").trim() || extraerTitulo(contenidoCrudo, tipo);

  const rows = await sbInsert("piezas", {
    cliente_id: cliente.id, tipo, titulo, contenido, comando: "manual", estado: "nueva",
  });
  const pieza = Array.isArray(rows) ? rows[0] : null;
  return json({ ok: true, pieza: pieza ? { id: pieza.id, tipo: pieza.tipo, titulo: pieza.titulo } : null });
}

// ============ HISTORIAL ============
async function handleGetHistorial(cliente: { id: string }) {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${cliente.id}&order=actualizado_en.desc&limit=1`);
  if (!convs || convs.length === 0) return json({ mensajes: [] });

  const msgs = await sbSelect("mensajes", "rol,contenido", `conversacion_id=eq.${convs[0].id}&order=creado_en.asc&limit=60`);
  return json({ mensajes: msgs || [] });
}

async function handleDeleteHistorial(cliente: { id: string }) {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${cliente.id}`);
  if (convs && convs.length) {
    for (const c of convs) {
      await sbDelete("mensajes", `conversacion_id=eq.${c.id}`);
      await sbDelete("conversaciones", `id=eq.${c.id}`);
    }
  }
  return json({ ok: true });
}

// ============ VICKY CHAT ============
async function handleGetHistorialVicky(cliente: { id: string }) {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${cliente.id}&tipo=eq.vicky&order=actualizado_en.desc&limit=1`);
  if (!convs || convs.length === 0) return json({ mensajes: [] });
  const msgs = await sbSelect("mensajes", "rol,contenido", `conversacion_id=eq.${convs[0].id}&order=creado_en.asc&limit=60`);
  return json({ mensajes: msgs || [] });
}

async function handleDeleteHistorialVicky(cliente: { id: string }) {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${cliente.id}&tipo=eq.vicky`);
  if (convs && convs.length) {
    for (const c of convs) {
      await sbDelete("mensajes", `conversacion_id=eq.${c.id}`);
      await sbDelete("conversaciones", `id=eq.${c.id}`);
    }
  }
  return json({ ok: true });
}

async function handleVickyChat(cliente: { id: string }, req: Request) {
  let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    try {
      const keyRows = await sbSelect("config", "valor", `clave=eq.anthropic_key&limit=1`);
      apiKey = keyRows?.[0]?.valor || null;
    } catch {}
  }
  if (!apiKey) return json({ error: "not_configured", message: "El motor no está configurado." }, 503);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const pregunta = String(payload?.mensaje || "").slice(0, MAX_CHARS_MENSAJE).trim();
  const archivos = Array.isArray(payload?.archivos) ? payload.archivos : [];
  if (!pregunta && !archivos.length) return json({ error: "missing_data", message: "Falta el mensaje." }, 400);

  const usados = await usoDeHoy(cliente.id);
  if (usados >= DEFAULT_DAILY_LIMIT) {
    return json({ error: "limite", message: "Llegaste al límite de hoy. Volvé mañana." }, 429);
  }

  const inicioPedido = Date.now();

  const perfiles = await sbSelect("perfiles", "manual,oferta,encuesta,fundacion", `cliente_id=eq.${cliente.id}&limit=1`);
  const perfil = perfiles?.[0] || null;
  if (!perfil?.oferta) return json({ error: "sin_perfil", message: "Primero cargá tu identidad." }, 409);

  // Historial del chat con Vicky (su propia conversación)
  let previosVicky: any[] = [];
  try { previosVicky = await historialV2(cliente.id, MENSAJES_CONTEXTO, "vicky"); } catch {}

  // Historial del chat con Synoma (para que Vicky sepa de qué venían hablando)
  let previosSynoma: any[] = [];
  try { previosSynoma = await historialV2(cliente.id, Math.floor(MENSAJES_CONTEXTO / 2), "synoma"); } catch {}

  // El historial de Synoma se resume como contexto para Vicky, no como su propia conversación
  let contextoSynoma = "";
  if (previosSynoma.length > 0) {
    const resumen = previosSynoma
      .map((m: any) => `${m.role === "user" ? "Cliente" : "Synoma"}: ${m.content.slice(0, 500)}`)
      .join("\n");
    contextoSynoma = `\n\n=== CONTEXTO: conversación previa con Synoma (el motor de contenido) ===\n${resumen}\n=== FIN DEL CONTEXTO ===\nUsá este contexto para no pedirle a la cliente que repita lo que ya le dijo a Synoma.`;
  }

  const system = [
    { type: "text", text: bloqueDePerfil(perfil), cache_control: { type: "ephemeral" } },
    { type: "text", text: VICKY_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: CONOCIMIENTO, cache_control: { type: "ephemeral" } },
    { type: "text", text: bloqueDeFecha() + contextoSynoma },
  ];

  const contenidoUsuario = await construirMensajeUsuario(pregunta, archivos);
  const trimmed = paraElModelo([...previosVicky, { role: "user", content: contenidoUsuario }]);

  let upstream;
  try { upstream = await callClaude(apiKey, system, trimmed); }
  catch { return json({ error: "upstream_error", message: "El motor no responde." }, 502); }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      let cerrado = false;
      const cerrar = () => { if (cerrado) return; cerrado = true; try { controller.close(); } catch {} };

      let respuesta = "";
      let emittedText = false;
      let stopReason: string | null = null;
      let resultado = "fin";

      const persistir = () => {
        if (!respuesta.trim()) return;
        guardarTurno(cliente.id, pregunta, respuesta, "vicky").catch(() => {});
        incrementarUso(cliente.id).catch(() => {});
      };

      emit({ type: "ping" });

      try {
        const r = await bombearStream(upstream.body!, emit, inicioPedido);
        respuesta = r.respuesta;
        emittedText = r.emittedText;
        stopReason = r.stopReason;
        resultado = r.resultado;

        if (resultado === "fin" && !emittedText && Date.now() - inicioPedido < MS_PARA_REINTENTAR) {
          try {
            const otra = await callClaude(apiKey, system, trimmed);
            const r2 = await bombearStream(otra.body!, emit, inicioPedido);
            respuesta = r2.respuesta;
            emittedText = r2.emittedText;
            stopReason = r2.stopReason;
            resultado = r2.resultado;
          } catch {}
        }

        if (resultado === "tarde") {
          emit({ type: "error", error: "demasiado_lento", message: "Vicky tardó demasiado. Probá de nuevo." });
          cerrar(); return;
        }
        if (resultado === "error") {
          emit({ type: "error", error: "stream_error", message: "Se cortó la conexión. Probá de nuevo." });
          persistir(); cerrar(); return;
        }
        if (!emittedText) {
          emit({ type: "error", error: "empty_response", message: "Vicky no respondió. Volvé a mandar el mensaje." });
          cerrar(); return;
        }

        const truncada = resultado === "tiempo" || stopReason === "max_tokens";
        emit({ type: "done", truncada, pieza: null });
        persistir();
      } catch {
        emit({ type: "error", error: "stream_aborted", message: "Se cortó la conexión. Probá de nuevo." });
        persistir();
      } finally { cerrar(); }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

// ============ CHAT ============
async function handleChat(cliente: { id: string }, req: Request) {
  let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    try {
      const keyRows = await sbSelect("config", "valor", `clave=eq.anthropic_key&limit=1`);
      apiKey = keyRows?.[0]?.valor || null;
    } catch {}
  }
  if (!apiKey) return json({ error: "not_configured", message: "El motor no está configurado." }, 503);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const pregunta = String(payload?.mensaje || "").slice(0, MAX_CHARS_MENSAJE).trim();
  const archivos = Array.isArray(payload?.archivos) ? payload.archivos : [];
  if (!pregunta && !archivos.length) return json({ error: "missing_data", message: "Falta el mensaje." }, 400);

  // Verificar límite diario
  const usados = await usoDeHoy(cliente.id);
  if (usados >= DEFAULT_DAILY_LIMIT) {
    return json({ error: "limite", message: "Llegaste al límite de hoy. Volvé mañana." }, 429);
  }

  const inicioPedido = Date.now();

  // Get profile
  const perfiles = await sbSelect("perfiles", "manual,oferta,encuesta,fundacion", `cliente_id=eq.${cliente.id}&limit=1`);
  const perfil = perfiles?.[0] || null;
  if (!perfil?.oferta) return json({ error: "sin_perfil", message: "Primero cargá tu identidad." }, 409);

  // Build system prompt
  const system = [
    { type: "text", text: bloqueDePerfil(perfil), cache_control: { type: "ephemeral" } },
    { type: "text", text: SYSTEM_BASE, cache_control: { type: "ephemeral" } },
    { type: "text", text: CONOCIMIENTO, cache_control: { type: "ephemeral" } },
    { type: "text", text: bloqueDeFecha() },
  ];

  // /racha: include biblioteca
  if (/^\/racha\b/i.test(pregunta)) {
    try {
      const piezas = await sbSelect("piezas", "tipo,titulo,estado,creado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc&limit=50`);
      if (piezas?.length) {
        const resumen = piezas.map((p: any) => `- ${p.titulo} (${p.tipo}, ${p.estado})`).join("\n");
        system.push({ type: "text", text: `=== BIBLIOTECA DEL CLIENTE ===\n${resumen}\n=== FIN ===` });
      }
    } catch {}
  }

  // /quepublico: inject client state so Claude knows which case applies
  if (/^\/quepublico\b/i.test(pregunta)) {
    try {
      const piezas = await sbSelect("piezas", "tipo,titulo,estado,creado_en,publicado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc&limit=100`);
      const hoy = new Date();
      const hoyStr = hoy.toDateString();
      const lunes = new Date(hoy);
      const dia = hoy.getDay();
      lunes.setDate(hoy.getDate() - (dia === 0 ? 6 : dia - 1));
      lunes.setHours(0, 0, 0, 0);

      const cicloActivo = piezas.find((p: any) => p.tipo === "cicloventa" && p.estado !== "archivada");
      const planSemana = piezas.find((p: any) => p.tipo === "plan" && new Date(p.creado_en) >= lunes);
      const publicadasHoy = piezas.filter((p: any) => p.estado === "publicada" && p.publicado_en && new Date(p.publicado_en).toDateString() === hoyStr);
      const piezasSemanaPublicadas = piezas.filter((p: any) =>
        p.estado === "publicada" && p.tipo !== "historia" && p.publicado_en && new Date(p.publicado_en) >= lunes
      ).length;
      const historiasHoy = piezas.some((p: any) =>
        p.estado === "publicada" && p.tipo === "historia" && p.publicado_en && new Date(p.publicado_en).toDateString() === hoyStr
      );

      const estado: string[] = [];
      if (cicloActivo) estado.push(`- Hay un CICLO DE PROMOCIÓN DE VENTAS ACTIVO (creado el ${new Date(cicloActivo.creado_en).toLocaleDateString("es-AR")}). El ciclo manda sobre cualquier otro plan.`);
      if (planSemana) estado.push(`- Ya tiene un PLAN SEMANAL creado esta semana (creado el ${new Date(planSemana.creado_en).toLocaleDateString("es-AR")}).`);
      else estado.push(`- NO tiene un plan semanal creado esta semana.`);
      estado.push(`- Piezas publicadas esta semana (excluyendo historias): ${piezasSemanaPublicadas}.`);
      estado.push(`- Historias publicadas hoy: ${historiasHoy ? "sí" : "no"}.`);
      estado.push(`- Piezas publicadas hoy: ${publicadasHoy.length}.`);
      if (publicadasHoy.length > 0) estado.push(`- Lo que ya publicó hoy: ${publicadasHoy.map((p: any) => p.titulo).join(", ")}.`);

      // Si hay ciclo de estrategia activo, inyectar el día que corresponde
      if (!cicloActivo) {
        try {
          const ciclos = await sbSelect("ciclos_estrategia", "id,mensaje_central,ideas_repetir,fecha_inicio,dias,numero_ciclo", `cliente_id=eq.${cliente.id}&estado=eq.activo&order=creado_en.desc&limit=1`);
          const cicloEstrategia = ciclos?.[0];
          if (cicloEstrategia) {
            const diasDesdeInicio = Math.floor((hoy.getTime() - new Date(cicloEstrategia.fecha_inicio).getTime()) / (1000 * 60 * 60 * 24));
            const diaCiclo = diasDesdeInicio + 1;
            const diasArray = Array.isArray(cicloEstrategia.dias) ? cicloEstrategia.dias : [];
            const diaActual = diasArray.find((d: any) => d.dia === diaCiclo) || diasArray[diasDesdeInicio];
            estado.push(`- Tiene un CICLO DE ESTRATEGIA ACTIVO (ciclo ${cicloEstrategia.numero_ciclo}), iniciado el ${new Date(cicloEstrategia.fecha_inicio).toLocaleDateString("es-AR")}.`);
            estado.push(`- Hoy es el DÍA ${diaCiclo} del ciclo.`);
            if (diaActual) estado.push(`- La pieza de hoy es:\n${diaActual.contenido}`);
            estado.push(`- Mensaje central del ciclo: "${cicloEstrategia.mensaje_central || ""}"`);
            if (cicloEstrategia.ideas_repetir) estado.push(`- 3 ideas a repetir: ${cicloEstrategia.ideas_repetir}`);
            estado.push(`\nUsá la pieza del día que corresponde del ciclo como base para recomendar qué publicar hoy. El mensaje central y las 3 ideas a repetir son el contexto para TODO lo que se genere hoy.`);
          }
        } catch {}
      }

      system.push({ type: "text", text: `=== ESTADO DEL CLIENTE PARA "QUÉ PUBLICO HOY" ===\n${estado.join("\n")}\n=== FIN ===\n\nUsá esta información para determinar qué caso aplica de los 4 del comando /quepublico (ver instrucciones en el system prompt).` });
    } catch {}
  }

  // /estrategia: motor de ciclos de 15 días
  let esEstrategia = false;
  if (/^\/estrategia\b/i.test(pregunta)) {
    esEstrategia = true;
    try {
      // 1. Verificar si hay ciclo de promoción de ventas activo
      const piezas = await sbSelect("piezas", "tipo,estado,creado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc&limit=100`);
      const cicloVentaActivo = piezas.find((p: any) => p.tipo === "cicloventa" && p.estado !== "archivada");
      if (cicloVentaActivo) {
        system.push({ type: "text", text: `=== AVISO IMPORTANTE ===\nEl cliente tiene un CICLO DE PROMOCIÓN DE VENTAS ACTIVO. Ese ciclo manda sobre cualquier otro plan. NO ejecutes el motor de estrategia de 15 días. Decile al cliente que ya tiene un ciclo de promoción activo y que cuando termine puede generar su estrategia de contenido.\n=== FIN ===` });
      } else {
        // 2. Buscar ciclos de estrategia existentes
        const ciclos = await sbSelect("ciclos_estrategia", "id,numero_ciclo,mensaje_central,estado,fecha_inicio,fecha_fin,creado_en", `cliente_id=eq.${cliente.id}&order=creado_en.desc&limit=5`);
        const hoy = new Date();
        const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString();

        const ciclosEsteMes = (ciclos || []).filter((c: any) => new Date(c.creado_en) >= new Date(inicioMes));
        const cicloActivo = (ciclos || []).find((c: any) => c.estado === "activo");
        const cicloAnteriorCompletado = (ciclos || []).find((c: any) => c.estado === "completado");

        // 3. Límite: máximo 2 ciclos por mes + 1 regeneración
        const ciclosNuevosEsteMes = ciclosEsteMes.filter((c: any) => !c.regeneracion);
        const regeneracionesEsteMes = ciclosEsteMes.filter((c: any) => c.regeneracion);

        if (ciclosNuevosEsteMes.length >= 2 && regeneracionesEsteMes.length >= 1) {
          system.push({ type: "text", text: `=== LÍMITE ALCANZADO ===\nEl cliente ya usó sus 2 ciclos + 1 regeneración de este mes. NO generes un ciclo nuevo. Decile que ya usó sus ciclos de este mes y ofrecéle editar días sueltos del ciclo activo en lugar de generar todo de cero. Editar un día suelto no cuenta contra el límite.\n=== FIN ===` });
        } else if (cicloActivo) {
          // Ya tiene un ciclo activo: ofrecer retomar o empezar nuevo
          const diasTranscurridos = Math.floor((hoy.getTime() - new Date(cicloActivo.fecha_inicio).getTime()) / (1000 * 60 * 60 * 24));
          system.push({ type: "text", text: `=== CICLO ACTIVO EXISTENTE ===\nEl cliente ya tiene un ciclo de estrategia ACTIVO (ciclo ${cicloActivo.numero_ciclo}), iniciado el ${new Date(cicloActivo.fecha_inicio).toLocaleDateString("es-AR")}. Van ${diasTranscurridos} días desde el inicio.\nMensaje central: "${cicloActivo.mensaje_central || "(no definido)"}"\n\nNO generes un ciclo nuevo automáticamente. Decile al cliente que ya tiene un ciclo en marcha y ofrecéle dos opciones:\n1. Retomar el que dejé por la mitad\n2. Empezar uno nuevo igual\nSi elige retomar, mostrale en qué día se quedó y seguí desde ahí.\nSi elige uno nuevo, marcá el anterior como abandonado y generá uno nuevo.\n=== FIN ===` });
        } else if (cicloAnteriorCompletado && ciclosNuevosEsteMes.length === 1) {
          // Es el ciclo 2: inyectar el ciclo anterior como contexto
          system.push({ type: "text", text: `=== CICLO ANTERIOR (ciclo 1 del mes) ===\nMensaje central: "${cicloAnteriorCompletado.mensaje_central || ""}"\nFecha de inicio: ${new Date(cicloAnteriorCompletado.fecha_inicio).toLocaleDateString("es-AR")}\n\nEste es el CICLO 2 del mes. Leé el ciclo anterior y arrancá desde donde quedó. Más peso en prueba, método, resultados, deseo y conversión. La oferta aparece con más frecuencia.\n=== FIN ===` });
        }
      }
    } catch {}
  }

  // Para todos los demás comandos de pieza: si hay ciclo de estrategia activo,
  // inyectar el mensaje central y las 3 ideas a repetir como contexto
  if (!esEstrategia && COMANDOS_PIEZA.some(c => new RegExp(`^/${c}\\b`, "i").test(pregunta))) {
    try {
      const ciclos = await sbSelect("ciclos_estrategia", "mensaje_central,ideas_repetir,fecha_inicio,dias,numero_ciclo", `cliente_id=eq.${cliente.id}&estado=eq.activo&order=creado_en.desc&limit=1`);
      const cicloActivo = ciclos?.[0];
      if (cicloActivo) {
        const hoy = new Date();
        const diasDesdeInicio = Math.floor((hoy.getTime() - new Date(cicloActivo.fecha_inicio).getTime()) / (1000 * 60 * 60 * 24));
        const diaCiclo = diasDesdeInicio + 1;
        const diasArray = Array.isArray(cicloActivo.dias) ? cicloActivo.dias : [];
        const diaActual = diasArray.find((d: any) => d.dia === diaCiclo) || diasArray[diasDesdeInicio];
        let ctx = `=== CICLO DE ESTRATEGIA ACTIVO (ciclo ${cicloActivo.numero_ciclo}, día ${diaCiclo}) ===\nMensaje central: "${cicloActivo.mensaje_central || ""}"\n3 ideas a repetir: ${cicloActivo.ideas_repetir || "(no definidas)"}\n`;
        if (diaActual) ctx += `Pieza de hoy según el ciclo:\n${diaActual.contenido}\n`;
        ctx += `=== FIN ===\nTodo lo que generes en esta pieza tiene que reforzar el mensaje central del ciclo y las 3 ideas a repetir. No escribas contenido que contradiga el posicionamiento del ciclo.`;
        system.push({ type: "text", text: ctx });
      }
    } catch {}
  }

  // Get history
  let previos: any[] = [];
  try { previos = await historialV2(cliente.id, MENSAJES_CONTEXTO); } catch {}
  const contenidoUsuario = await construirMensajeUsuario(pregunta, archivos);
  const trimmed = paraElModelo([...previos, { role: "user", content: contenidoUsuario }]);

  // Call Claude
  let upstream;
  try { upstream = await callClaude(apiKey, system, trimmed); }
  catch { return json({ error: "upstream_error", message: "El motor no responde." }, 502); }

  // Stream NDJSON
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      let cerrado = false;
      const cerrar = () => { if (cerrado) return; cerrado = true; try { controller.close(); } catch {} };

      let respuesta = "";
      let emittedText = false;
      let stopReason: string | null = null;
      let resultado = "fin";

      const persistir = () => {
        if (!respuesta.trim()) return;
        guardarTurno(cliente.id, pregunta, respuesta).catch(() => {});
        incrementarUso(cliente.id).catch(() => {});
      };

      emit({ type: "ping" });

      try {
        const r = await bombearStream(upstream.body!, emit, inicioPedido);
        respuesta = r.respuesta;
        emittedText = r.emittedText;
        stopReason = r.stopReason;
        resultado = r.resultado;

        if (resultado === "fin" && !emittedText && Date.now() - inicioPedido < MS_PARA_REINTENTAR) {
          try {
            const otra = await callClaude(apiKey, system, trimmed);
            const r2 = await bombearStream(otra.body!, emit, inicioPedido);
            respuesta = r2.respuesta;
            emittedText = r2.emittedText;
            stopReason = r2.stopReason;
            resultado = r2.resultado;
          } catch {}
        }

        if (resultado === "tarde") {
          emit({ type: "error", error: "demasiado_lento", message: "El motor tardó demasiado. Probá de nuevo." });
          cerrar(); return;
        }
        if (resultado === "error") {
          emit({ type: "error", error: "stream_error", message: "El motor se cortó. Probá de nuevo." });
          persistir(); cerrar(); return;
        }
        if (!emittedText) {
          emit({ type: "error", error: "empty_response", message: "El motor no respondió. Volvé a mandar el mensaje." });
          cerrar(); return;
        }

        let pieza = null;
        try { pieza = await guardarSiEsPieza(cliente.id, pregunta, respuesta); } catch {}

        // /estrategia: si la respuesta contiene el cierre del ciclo, guardarlo
        if (esEstrategia && pieza) {
          try {
            const cicloData = extraerCicloEstrategia(respuesta);
            if (cicloData) {
              // Determinar número de ciclo
              const hoy = new Date();
              const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString();
              const ciclos = await sbSelect("ciclos_estrategia", "id,numero_ciclo,regeneracion", `cliente_id=eq.${cliente.id}&creado_en=gt.${inicioMes}&order=creado_en.desc&limit=5`);
              const ciclosNuevos = (ciclos || []).filter((c: any) => !c.regeneracion);
              const numCiclo = ciclosNuevos.length >= 1 ? 2 : 1;

              // Marcar ciclo anterior activo como abandonado si existe
              const cicloActivoPrev = (ciclos || []).find((c: any) => c.estado === "activo");
              if (cicloActivoPrev) {
                await sbUpdate("ciclos_estrategia", { estado: "abandonado", actualizado_en: new Date().toISOString() }, `id=eq.${cicloActivoPrev.id}`);
              }

              const fechaInicio = hoy.toISOString().slice(0, 10);
              const fechaFin = new Date(hoy.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

              await sbInsert("ciclos_estrategia", {
                cliente_id: cliente.id,
                mensaje_central: cicloData.mensaje_central,
                percepcion_inicial: cicloData.percepcion_inicial,
                percepcion_final: cicloData.percepcion_final,
                ideas_repetir: cicloData.ideas_repetir,
                no_publicar: cicloData.no_publicar,
                dias: cicloData.dias,
                numero_ciclo: numCiclo,
                fecha_inicio: fechaInicio,
                fecha_fin: fechaFin,
                estado: "activo",
              });
            }
          } catch {}
        }

        const truncada = resultado === "tiempo" || stopReason === "max_tokens";
        emit({ type: "done", truncada, pieza: pieza ? { id: pieza.id, tipo: pieza.tipo, titulo: pieza.titulo } : null });
        persistir();
      } catch {
        emit({ type: "error", error: "stream_aborted", message: "Se cortó la conexión. Probá de nuevo." });
        persistir();
      } finally { cerrar(); }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
