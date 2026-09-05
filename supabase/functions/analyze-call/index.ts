import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

// --- Supabase REST helpers (service role — BYPASSRLS) ---
async function sbSelect(table: string, select: string, filter: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?select=${encodeURIComponent(select)}&${filter}`;
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

// --- Session validation (same as synoma-chat) ---
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function validarSesion(token: string): Promise<{ id: string; email: string } | null> {
  if (!token) return null;
  const tokenHash = await sha256(token);
  const rows = await sbSelect("sesiones", "cliente_id", `token_hash=eq.${tokenHash}&expira_en=gt.${new Date().toISOString()}&limit=1`);
  if (!rows || rows.length === 0) return null;
  const clienteId = rows[0].cliente_id;
  const clientes = await sbSelect("clientes", "id,email,acceso", `id=eq.${clienteId}&limit=1`);
  if (!clientes || clientes.length === 0) return null;
  const c = clientes[0];
  if (c.acceso !== "activo") return null;
  return { id: c.id, email: c.email };
}

// --- Config helper ---
async function getConfig(clave: string): Promise<string | null> {
  try {
    const rows = await sbSelect("config", "valor", `clave=eq.${clave}&limit=1`);
    return rows?.[0]?.valor || null;
  } catch {
    return null;
  }
}

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 12000;

const SYSTEM_PROMPT = `Sos un Sales Manager experto y coach de ventas de élite. Analizás transcripciones de llamadas de venta.

## PRINCIPIOS
- IMPORTA lo que dice el prospecto, no lo que el vendedor interpreta
- NO INFERIR: si el prospecto no lo dijo, no asumirlo
- El vendedor diagnostica preguntando, no enseñando
- Resultado ≠ Ejecución: una venta puede ocurrir a pesar de una mala llamada
- NO INVENTAR. Toda crítica debe tener cita de la transcripción o referencia al script
- Sé conciso en cada campo. Calidad sobre cantidad.

## OUTPUT
Devolvé ÚNICAMENTE un JSON válido. Sin texto antes ni después. Sin markdown.
Estructura EXACTA:
{
  "overall_score": <0-10>,
  "script_adherence": <0-100>,
  "sales_quality": <0-10>,
  "summary": "<diagnóstico en 2-3 líneas>",
  "primary_strength": "<fortaleza principal>",
  "primary_improvement": "<mejora principal>",
  "next_call_action": "<una acción concreta y observable para la próxima>",
  "best_thing": "<lo mejor de la llamada, una cosa>",
  "hardest_thing": "<lo que más costó, una cosa>",
  "phases": [
    {
      "name": "<nombre de la fase>",
      "weight": <peso 0-100>,
      "score": <0-10>,
      "status": "executed|partial|missing|deviated_good",
      "objective": "<qué buscaba conseguir esta fase>",
      "what_happened": "<qué hizo el closer, sin juzgar>",
      "evidence": "<cita exacta de la transcripción>",
      "what_went_well": ["<máximo 3 puntos>"],
      "what_to_improve": ["<máximo 3 puntos>"],
      "missed_opportunity": "<frase del prospecto que merecía seguimiento o null>",
      "alternative_script": "<frase concreta que el closer podría haber usado o null>"
    }
  ],
  "missed_opportunities": [
    {
      "prospect_said": "<cita>",
      "why_it_mattered": "<explicación breve>",
      "could_have_asked": "<pregunta específica>"
    }
  ],
  "objections": [
    {
      "type": "precio|liquidez|timing|pareja|confianza|producto|autoridad|implementacion|miedo|prioridad|pensar|comparacion|urgencia|otra",
      "stated": "<objeción textual>",
      "real_objection": "<posible objeción real>",
      "closer_response": "<cómo respondió>",
      "response_quality": <0-10>,
      "better_response": "<qué podría haber hecho distinto>"
    }
  ],
  "critical_errors": [
    {
      "title": "<título del error>",
      "impact": "ALTO|MEDIO|BAJO",
      "what_happened": "<descripción breve>",
      "what_to_do": "<instrucción concreta>"
    }
  ],
  "key_moments": ["<momento 1>", "<momento 2>"],
  "prospect_profile": {
    "fit": "alto|medio|bajo",
    "main_problem": "<problema principal>",
    "desired_outcome": "<resultado deseado>",
    "motivation": "<motivación>",
    "urgency": "<urgencia>",
    "budget": "<capacidad económica>",
    "authority": "<autoridad de decisión>",
    "main_objection": "<objeción principal>",
    "close_risk": "<riesgo de no cierre>",
    "buying_signals": ["<señal 1>"],
    "warning_signals": ["<señal 1>"]
  },
  "victoria_feedback": {
    "my_reading": "<1-2 párrafos, lectura estratégica de la llamada>",
    "the_real_problem": "<el verdadero problema, no el síntoma>",
    "the_moment": "<el momento donde yo me hubiera quedado + evidencia>",
    "what_i_would_do": "<qué haría diferente, máximo 3 acciones>",
    "why": "<explicación simple de la lógica>",
    "for_next_call": "<una acción para la próxima llamada>",
    "one_thing_to_practice": "<una habilidad a practicar>"
  },
  "confidence_score": <0-100>,
  "talk_ratio": {"closer": <porcentaje>, "prospect": <porcentaje>} | null,
  "training_exercise": {
    "context": "<contexto del ejercicio>",
    "question": "<pregunta para el closer>"
  } | null
}`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // --- Validate session ---
    const authHeader = req.headers.get("Authorization") || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7);
    if (!token) {
      let body0;
      try { body0 = await req.clone().json(); } catch { body0 = {}; }
      token = String(body0?.token || "");
    }
    const cliente = await validarSesion(token);
    if (!cliente) return json({ error: "no_sesion", message: "Tu sesión expiró. Volvé a entrar." }, 401);

    // --- Parse request ---
    let payload;
    try { payload = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    const callId = String(payload?.callId || "").trim();
    if (!callId) return json({ error: "bad_data", message: "Falta el ID de la llamada." }, 400);

    // --- Get the call, verify ownership ---
    const calls = await sbSelect("calls", "id,cliente_id,transcript,salesperson_name,prospect_name,call_date,call_result,playbook_version", `id=eq.${callId}&limit=1`);
    if (!calls || calls.length === 0) return json({ error: "not_found", message: "La llamada no existe." }, 404);
    const call = calls[0];
    if (call.cliente_id !== cliente.id) return json({ error: "forbidden", message: "No tenés acceso a esta llamada." }, 403);

    // --- Update status to analyzing ---
    await sbUpdate("calls", { status: "analyzing" }, `id=eq.${callId}`);

    // --- Get active playbook ---
    let playbook: { script_text: string; offer_text: string | null; name: string } | null = null;
    try {
      const playbooks = await sbSelect("sales_playbooks", "id,name,offer_text,script_text", `cliente_id=eq.${cliente.id}&is_active=eq.true&order=created_at.desc&limit=1`);
      playbook = playbooks?.[0] || null;
    } catch {}

    // --- Get API key ---
    let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      try {
        const keyRows = await sbSelect("config", "valor", `clave=eq.anthropic_key&limit=1`);
        apiKey = keyRows?.[0]?.valor || null;
      } catch {}
    }
    if (!apiKey) return json({ error: "no_api_key", message: "El servicio no está configurado." }, 500);

    // --- Build user message ---
    const callInfo = [
      `Vendedor: ${call.salesperson_name || "(no especificado)"}`,
      `Prospecto: ${call.prospect_name || "(no especificado)"}`,
      `Fecha: ${call.call_date || "(no especificada)"}`,
      `Resultado: ${call.call_result || "(no especificado)"}`,
    ].join("\n");

    const playbookContext = playbook
      ? `\n\n=== CONTEXTO DEL PLAYBOOK ===\nNombre del proceso: ${playbook.name}\nOferta:\n${playbook.offer_text || "(no cargada)"}\n\nScript de venta:\n${playbook.script_text}\n=== FIN DEL CONTEXTO ===`
      : "\n\n(No hay playbook cargado. Analizá con criterio general de Founders Sales Method.)";

    const userMessage = `Datos de la llamada:\n${callInfo}\n\nTranscripción:\n${call.transcript}${playbookContext}`;

    // --- Call Claude ---
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
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
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => "");
      await sbUpdate("calls", { status: "failed" }, `id=eq.${callId}`);
      return json({ error: "claude_error", message: "El motor de análisis no respondió.", debug: errText.slice(0, 500) }, 502);
    }

    const claudeData = await claudeRes.json();
    const textBlock = claudeData?.content?.find((b: any) => b?.type === "text");
    let rawText = textBlock?.text || "";
    const stopReason = claudeData?.stop_reason || "";

    // --- Parse JSON from Claude response ---
    let analysis: any;
    try {
      const s = rawText.indexOf("{");
      const e = rawText.lastIndexOf("}");
      const jsonStr = (s !== -1 && e !== -1) ? rawText.slice(s, e + 1) : rawText;
      analysis = JSON.parse(jsonStr);
    } catch {
      analysis = { summary: rawText.slice(0, 2000), overall_score: null, script_adherence: null, sales_quality: null };
    }

    // --- Save analysis ---
    const scores = {
      overall_score: analysis.overall_score,
      script_adherence: analysis.script_adherence,
      sales_quality: analysis.sales_quality,
    };

    await sbInsert("call_analyses", {
      call_id: callId,
      cliente_id: cliente.id,
      scores: scores,
      observations: analysis.primary_improvement || null,
      summary: analysis.summary || null,
      overall_score: analysis.overall_score ?? null,
      full_analysis: analysis,
    });

    // --- Update call status ---
    await sbUpdate("calls", { status: "completed" }, `id=eq.${callId}`);

    return json({ ok: true, analysis });
  } catch (err) {
    console.error("analyze-call error:", err);
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body?.callId) {
        await sbUpdate("calls", { status: "failed" }, `id=eq.${body.callId}`);
      }
    } catch {}
    return json({ error: "server_error", message: "Error interno del servidor.", debug: String(err?.message || err || "").slice(0, 500) }, 500);
  }
});
