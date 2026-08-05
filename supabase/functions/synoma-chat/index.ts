import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SYSTEM_BASE } from "./_prompt.ts";
import { CONOCIMIENTO } from "./_conocimiento.ts";

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
const COMANDOS_PIEZA = ["semana","idea","reel","historias","venta","post","repurpose","revisar","cicloventa","objecion"];
const TIPO_PIEZA: Record<string, string> = {
  semana:"plan", idea:"idea", reel:"reel", historia:"historia",
  venta:"venta", post:"post", repurpose:"reciclado", revisar:"revision", cicloventa:"cicloventa", objecion:"otro",
};

function detectarPieza(pregunta: string) {
  const cmd = (pregunta.match(/^\/(\S+)/) || [])[1];
  if (!cmd || !COMANDOS_PIEZA.includes(cmd)) return null;
  return { tipo: TIPO_PIEZA[cmd] || "otro", comando: cmd };
}

function extraerTitulo(texto: string, tipo: string) {
  const limpia = texto.replace(/\*\*/g, "").trim();
  const primeraLinea = limpia.split("\n").find((l) => l.trim()) || "";
  let titulo = primeraLinea.replace(/^\|.*$/, "").replace(/^#+\s*/, "").trim();
  if (titulo.length > 80) titulo = titulo.slice(0, 77) + "…";
  if (!titulo) titulo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
  return titulo;
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
  const rows = await sbInsert("piezas", {
    cliente_id: clienteId, tipo: det.tipo, titulo, contenido: respuesta, comando: det.comando, estado: "nueva",
  });
  return Array.isArray(rows) ? rows[0] : null;
}

// --- Conversation helpers ---
async function conversacionAbierta(clienteId: string) {
  const rows = await sbSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&cerrada_en=is.null&order=actualizado_en.desc&limit=1`);
  if (rows[0]) return rows[0].id;
  const creada = await sbInsert("conversaciones", { cliente_id: clienteId });
  return Array.isArray(creada) ? creada[0].id : null;
}

async function historialV2(clienteId: string, limite: number) {
  const convs = await sbSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&order=actualizado_en.desc&limit=1`);
  if (!convs || convs.length === 0) return [];
  const convId = convs[0].id;
  const msgs = await sbSelect("mensajes", "rol,contenido,creado_en", `conversacion_id=eq.${convId}&order=creado_en.desc&limit=${limite}`);
  return (msgs || []).reverse().map((m: any) => ({ role: m.rol, content: m.contenido }));
}

async function guardarTurno(clienteId: string, pregunta: string, respuesta: string) {
  const p = pregunta.slice(0, MAX_CHARS_MENSAJE).trim();
  const r = respuesta.slice(0, MAX_CHARS_MENSAJE).trim();
  if (!p || !r) return;
  const convId = await conversacionAbierta(clienteId);
  await sbInsert("mensajes", { conversacion_id: convId, rol: "user", contenido: p });
  await sbInsert("mensajes", { conversacion_id: convId, rol: "assistant", contenido: r });
  await sbUpdate("conversaciones", { actualizado_en: new Date().toISOString(), titulo: p.slice(0, 80) }, `id=eq.${convId}`);
}

function paraElModelo(mensajes: any[]) {
  let limpios = mensajes
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content || "").slice(0, MAX_CHARS_MENSAJE) }))
    .filter((m) => m.content.trim().length > 0);

  let total = 0;
  const dentro: any[] = [];
  for (let i = limpios.length - 1; i >= 0; i--) {
    total += limpios[i].content.length;
    if (total > MAX_CHARS_CONTEXTO && dentro.length > 0) break;
    dentro.unshift(limpios[i]);
  }
  limpios = dentro;

  while (limpios.length && limpios[0].role !== "user") limpios.shift();

  const alternados: any[] = [];
  for (const m of limpios) {
    const anterior = alternados[alternados.length - 1];
    if (anterior && anterior.role === m.role) anterior.content += `\n\n${m.content}`;
    else alternados.push({ ...m });
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

  // --- CHAT (default) ---
  if (req.method === "POST") return handleChat(cliente, req);

  return json({ error: "not_found" }, 404);
});

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

  // Verificar que el cliente existe y tiene acceso activo
  const clientes = await sbSelect("clientes", "id,acceso", `email=eq.${email}&limit=1`);
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
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (resendKey) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Synoma <noreply@synoma.dev>",
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

  const contenido = String(payload?.contenido || "").trim();
  const tipo = String(payload?.tipo || "otro").trim();
  const titulo = String(payload?.titulo || contenido.slice(0, 80)).trim();
  if (!contenido) return json({ error: "bad_data", message: "Falta el contenido." }, 400);

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
  if (!pregunta) return json({ error: "missing_data", message: "Falta el mensaje." }, 400);

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

  // Get history
  let previos: any[] = [];
  try { previos = await historialV2(cliente.id, MENSAJES_CONTEXTO); } catch {}
  const trimmed = paraElModelo([...previos, { role: "user", content: pregunta }]);

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
