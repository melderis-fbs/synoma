import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { SYSTEM_BASE } from "./_prompt.ts";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = Number(Deno.env.get("SYNOMA_MAX_TOKENS")) || 8000;
const DEADLINE_MS = Number(Deno.env.get("SYNOMA_DEADLINE_MS")) || 45000;
const MS_PARA_REINTENTAR = Number(Deno.env.get("SYNOMA_MS_REINTENTO")) || 35000;
const MAX_CHARS_MENSAJE = 20000;
const DEFAULT_DAILY_LIMIT = 60;
const MENSAJES_CONTEXTO = 24;
const MAX_CHARS_CONTEXTO = 40000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// --- Supabase REST helper (PostgREST) ---
async function supabaseSelect(table: string, query: string, filter: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?select=${encodeURIComponent(query)}&${filter}`;
  const res = await fetch(url, {
    headers: {
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
    },
  });
  if (!res.ok) throw new Error(`supabase ${table}: ${res.status}`);
  return res.json();
}

async function supabaseInsert(table: string, body: Record<string, unknown>) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase insert ${table}: ${res.status}`);
  return res.json();
}

async function supabaseUpdate(table: string, body: Record<string, unknown>, filter: string) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase update ${table}: ${res.status}`);
  return res.json();
}

async function supabaseDelete(table: string, filter: string) {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: {
      apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
    },
  });
  if (!res.ok) throw new Error(`supabase delete ${table}: ${res.status}`);
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
const COMANDOS_PIEZA = ["semana","idea","guion","gancho","historias","venta","post","repurpose","revisar","objecion"];
const TIPO_PIEZA: Record<string, string> = {
  semana:"plan", idea:"idea", guion:"guion", gancho:"gancho", historia:"historia",
  venta:"venta", post:"post", repurpose:"reciclado", revisar:"revision", objecion:"otro",
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

async function guardarSiEsPieza(clienteId: string, pregunta: string, respuesta: string) {
  const det = detectarPieza(pregunta);
  if (!det) return null;
  const titulo = extraerTitulo(respuesta, det.tipo);
  const rows = await supabaseInsert("piezas", {
    cliente_id: clienteId, tipo: det.tipo, titulo, contenido: respuesta, comando: det.comando, estado: "nueva",
  });
  return Array.isArray(rows) ? rows[0] : null;
}

// --- Conversation helpers ---
async function conversacionAbierta(clienteId: string) {
  const rows = await supabaseSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&cerrada_en=is.null&order=actualizado_en.desc&limit=1`);
  if (rows[0]) return rows[0].id;
  const creada = await supabaseInsert("conversaciones", { cliente_id: clienteId });
  return Array.isArray(creada) ? creada[0].id : null;
}

async function historial(clienteId: string, limite: number) {
  const rows = await supabaseSelect(
    "mensajes",
    "rol,contenido,creado_en",
    `conversacion_id.in.(select id from conversaciones where cliente_id=eq.${clienteId})&order=creado_en.desc,creado_en.desc&limit=${limite}`
  );
  // Note: PostgREST doesn't support subqueries in filters like this.
  // We need a different approach: first get the conversation, then get messages.
  return rows;
}

async function historialV2(clienteId: string, limite: number) {
  // Get the open conversation
  const convs = await supabaseSelect("conversaciones", "id", `cliente_id=eq.${clienteId}&order=actualizado_en.desc&limit=1`);
  if (!convs || convs.length === 0) return [];
  const convId = convs[0].id;
  // Get last N messages
  const msgs = await supabaseSelect("mensajes", "rol,contenido,creado_en", `conversacion_id=eq.${convId}&order=creado_en.desc&limit=${limite}`);
  // Map DB columns (rol, contenido) to the shape the API expects (role, content)
  return (msgs || []).reverse().map((m: any) => ({ role: m.rol, content: m.contenido }));
}

async function guardarTurno(clienteId: string, pregunta: string, respuesta: string) {
  const p = pregunta.slice(0, MAX_CHARS_MENSAJE).trim();
  const r = respuesta.slice(0, MAX_CHARS_MENSAJE).trim();
  if (!p || !r) return;
  const convId = await conversacionAbierta(clienteId);
  await supabaseInsert("mensajes", { conversacion_id: convId, rol: "user", contenido: p });
  await supabaseInsert("mensajes", { conversacion_id: convId, rol: "assistant", contenido: r });
  await supabaseUpdate("conversaciones", { actualizado_en: new Date().toISOString(), titulo: p.slice(0, 80) }, `id=eq.${convId}`);
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

// Pumps a Claude stream from start to end, emitting text deltas as NDJSON.
// Returns 'fin' on success, 'error' if the stream reported a failure,
// 'tiempo' if we ran out of time, or 'tarde' if the model never started writing.
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    try {
      const keyRows = await supabaseSelect("config", "valor", `clave=eq.anthropic_key&limit=1`);
      apiKey = keyRows?.[0]?.valor || null;
    } catch {}
  }
  if (!apiKey) return json({ error: "not_configured", message: "El motor no está configurado." }, 503);

  let payload;
  try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const clienteId = String(payload?.cliente_id || "").trim();
  const pregunta = String(payload?.mensaje || "").slice(0, MAX_CHARS_MENSAJE).trim();
  if (!clienteId || !pregunta) return json({ error: "missing_data", message: "Falta el mensaje o la sesión." }, 400);

  const inicioPedido = Date.now();

  // Get profile
  const perfiles = await supabaseSelect("perfiles", "manual,oferta,encuesta,fundacion", `cliente_id=eq.${clienteId}&limit=1`);
  const perfil = perfiles?.[0] || null;
  if (!perfil?.oferta) return json({ error: "sin_perfil", message: "Primero cargá tu identidad." }, 409);

  // Build system prompt — perfil PRIMERO, reglas DESPUÉS.
  // El perfil es la información más importante: si va primero, Claude lo
  // lee con atención fresca y lo usa de ancla para todo lo demás. Las reglas
  // van después porque le dicen cómo usar lo que ya leyó.
  const system = [
    { type: "text", text: bloqueDePerfil(perfil), cache_control: { type: "ephemeral" } },
    { type: "text", text: SYSTEM_BASE, cache_control: { type: "ephemeral" } },
    { type: "text", text: bloqueDeFecha() },
  ];

  // /racha: include biblioteca
  if (/^\/racha\b/i.test(pregunta)) {
    try {
      const piezas = await supabaseSelect("piezas", "tipo,titulo,estado,creado_en", `cliente_id=eq.${clienteId}&order=creado_en.desc&limit=50`);
      if (piezas?.length) {
        const resumen = piezas.map((p: any) => `- ${p.titulo} (${p.tipo}, ${p.estado})`).join("\n");
        system.push({ type: "text", text: `=== BIBLIOTECA DEL CLIENTE ===\n${resumen}\n=== FIN ===` });
      }
    } catch {}
  }

  // Get history
  let previos: any[] = [];
  try { previos = await historialV2(clienteId, MENSAJES_CONTEXTO); } catch {}
  const trimmed = paraElModelo([...previos, { role: "user", content: pregunta }]);

  // Call Claude
  let upstream;
  try { upstream = await callClaude(apiKey, system, trimmed); }
  catch (e) { return json({ error: "upstream_error", message: "El motor no responde." }, 502); }

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
        guardarTurno(clienteId, pregunta, respuesta).catch(() => {});
      };

      emit({ type: "ping" });

      try {
        const r = await bombearStream(upstream.body!, emit, inicioPedido);
        respuesta = r.respuesta;
        emittedText = r.emittedText;
        stopReason = r.stopReason;
        resultado = r.resultado;

        // Empty response: retry once silently if we still have time budget.
        // Same logic as the Netlify version: a blank completion is a transient
        // API hiccup, and making the client re-type their /semana is making them
        // pay for a problem that isn't theirs.
        if (resultado === "fin" && !emittedText && Date.now() - inicioPedido < MS_PARA_REINTENTAR) {
          console.warn("[synoma] respuesta vacía — reintentando una vez");
          try {
            const otra = await callClaude(apiKey, system, trimmed);
            const r2 = await bombearStream(otra.body!, emit, inicioPedido);
            respuesta = r2.respuesta;
            emittedText = r2.emittedText;
            stopReason = r2.stopReason;
            resultado = r2.resultado;
          } catch (e) {
            console.error("[synoma] el reintento también falló:", e?.message ?? e);
          }
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

        // Save piece if applicable
        let pieza = null;
        try { pieza = await guardarSiEsPieza(clienteId, pregunta, respuesta); } catch {}

        const truncada = resultado === "tiempo" || stopReason === "max_tokens";
        emit({ type: "done", truncada, pieza: pieza ? { id: pieza.id, tipo: pieza.tipo, titulo: pieza.titulo } : null });
        persistir();
      } catch (e) {
        emit({ type: "error", error: "stream_aborted", message: "Se cortó la conexión. Probá de nuevo." });
        persistir();
      } finally { cerrar(); }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
});
