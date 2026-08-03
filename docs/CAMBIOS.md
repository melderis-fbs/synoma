# Errores encontrados y su arreglo

Cada problema con el arreglo concreto que se aplicó. El detalle del análisis
original está en [`EVALUACION.md`](./EVALUACION.md).

Todo esto está implementado y con tests: `npm test` → 132 tests en verde.

---

## 🔴 1. La respuesta tardaba más que el timeout de Netlify

**El error.** `synoma.js` pedía `max_tokens: 2500` sin streaming. Una respuesta
de ese tamaño tarda 30-40 segundos en generarse; Netlify corta las funciones
síncronas a los 10 segundos. El comando principal, `/semana`, fallaba casi
siempre.

**Por qué no se arreglaba con un flag.** El formato viejo devolvía un objeto:

```js
exports.handler = async (event) => {
  const data = await res.json();                    // ← espera TODA la respuesta
  return { statusCode: 200, body: JSON.stringify({ text }) };
};
```

Ese formato no puede hacer streaming: la función no termina hasta tener el texto
completo. Hay que devolver un `Response` con un stream como cuerpo, que es
Netlify Functions 2.0.

**El arreglo.**

```js
export default async (req) => {
  const upstream = await callClaude({ ... });        // stream: true
  return new Response(toNdjson(upstream.body, code), {
    headers: { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' },
  });
};
export const config = { path: '/api/synoma' };
```

La función devuelve el `Response` en ~1 segundo y el texto sigue llegando por el
stream. Beneficio secundario: el cliente ve el texto aparecer palabra por
palabra en vez de mirar una pantalla en blanco 40 segundos.

El servidor traduce el SSE de Anthropic a NDJSON (una línea de JSON por evento),
que el navegador lee incremental sin necesitar un parser de SSE.

> **Verificá esto en tu plan de Netlify.** Con streaming la función devuelve
> rápido y el timeout de respuesta deja de ser el problema, pero sigue habiendo
> un tope total de ejecución. Si aun así se corta, las salidas son bajar
> `MAX_TOKENS` o mover la función a Netlify Edge Functions.

**Tests:** `pide streaming a la API`, `traduce el SSE de Anthropic a NDJSON`.

---

## 🔴 2. Cualquier error mostraba contenido inventado como si fuera del cliente

**El error.** El `catch` del frontend no distinguía nada:

```js
}catch(e){
  $('demo-pill').style.display='block';
  const demo = demoReply(text);        // ← plan inventado sobre DIETAS
  HISTORY.push({role:'assistant', content:demo});
  addMsg('bot', demo, 'Synoma · demo');
}
```

Timeout, código inválido, caída de la API, internet cortado: todo terminaba
mostrando un plan semanal hardcodeado sobre nutrición, guardado en el historial
como si Synoma lo hubiera escrito. Un cliente de otro rubro lo tomaba por real.

**El arreglo, en tres partes.**

*Uno.* El servidor ahora devuelve códigos de error distinguibles:

| Situación | HTTP | `error` |
|---|---|---|
| Falta `ANTHROPIC_API_KEY` o `SYNOMA_CODES` | 503 | `not_configured` |
| Código del cliente inválido | 403 | `invalid_code` |
| Origen no permitido | 403 | `forbidden_origin` |
| Tope diario alcanzado | 429 | `daily_limit` |
| La API de Claude no responde | 502 | `upstream_error` |
| Se cortó a mitad del stream | 200 | `stream_error` (dentro del stream) |

*Dos.* El modo demo se activa **solo** con `not_configured`:

```js
if(code === 'not_configured'){
  $('demo-pill').style.display='block';
  addMsg('bot', demoReply(), 'Ejemplo — motor sin conectar');
  return;                          // NO se guarda en HISTORY: no es contenido real
}
// cualquier otro error se muestra como error, con su mensaje
startMsg('bot', 'No se pudo responder').appendChild(errorNote(message));
```

*Tres.* El texto de emergencia ya no imita contenido del cliente. Antes era un
plan semanal creíble; ahora dice explícitamente que no es suyo:

> ⚠️ **Esto no es tu contenido.** El motor no está conectado en este momento —
> falta configurar la API en el servidor. Avisale a tu coach.

**Bonus:** si el stream se corta a mitad, se conserva el texto parcial que llegó
y se marca el corte debajo, en vez de perderlo todo.

**Tests:** `sin API key devuelve not_configured`, `código inválido devuelve 403
invalid_code, no not_configured`, `un error a mitad del stream se reporta, no se
hace pasar por éxito`.

---

## 🟠 3. La API key quedaba expuesta a abuso desde cualquier sitio web

**El error.** `Access-Control-Allow-Origin: '*'` — cualquier página web del
mundo podía llamar tu función. Sumado a que los códigos son compartidos, viajan
por Telegram y no había ningún tope, un código filtrado significaba consumo
ilimitado de tu key desde donde fuera.

**El arreglo, en tres capas.**

*Uno — se elimina el CORS abierto.* La app se sirve del mismo dominio que la
función, así que no necesita CORS. Ahora solo se emiten headers CORS si
configurás `SYNOMA_ALLOWED_ORIGINS` a propósito (para el caso de embeber la app
en otro dominio).

*Dos — chequeo de origen del lado del servidor.* Esto es lo importante y es
sutil: **CORS solo evita que un sitio ajeno *lea* la respuesta. La petición se
ejecuta igual y consume tokens.** O sea que quitar el `*` no alcanza; hace falta
rechazar en el servidor:

```js
if (!originAllowed(req)) {
  return fail(403, 'forbidden_origin', 'Origen no permitido.', cors);
}
```

*Tres — tope de mensajes por código y por día.* En Netlify Blobs, sin base de
datos:

```js
const key = `${code}:${new Date().toISOString().slice(0,10)}`;  // FND-ANA1:2026-07-30
const current = Number(await store.get(key) ?? 0);
if (current >= limit) return fail(429, 'daily_limit', ...);
```

Default 60 mensajes/día por código (ajustable con `SYNOMA_DAILY_LIMIT`). Pone un
techo duro al gasto: 60 mensajes × ~0,04 USD ≈ 2,40 USD por día en el peor caso
por código, incluso si se filtra.

**Honestidad sobre el alcance:** el chequeo de origen no frena a un script (curl
no manda header `Origin`). Contra eso lo que protege es el código válido más el
tope diario. Las tres capas juntas cierran el agujero de "cualquiera desde
cualquier web"; el tope acota el daño de un código filtrado.

**Decisión consciente:** si Blobs falla, la petición **pasa** (fail open) en vez
de bloquearse. Un problema del contador no debería tumbar el producto. El costo
es que durante una caída de Blobs no hay tope.

**Tests:** `un origen ajeno se rechaza antes de gastar tokens`, `nunca se
devuelve Access-Control-Allow-Origin: *`, `un origen externo explícitamente
permitido sí pasa`.

---

## 🟠 4. Se publicaban archivos internos en el dominio público

**El error.** `publish = "."` publicaba toda la raíz del repo. `README-DEPLOY.md`
quedaba legible por cualquiera en `https://synoma.foundersbs.com/README-DEPLOY.md`,
y ese archivo dice quién compró la key de la API, el formato de los códigos de
acceso, el costo por cliente y el proceso interno del equipo. Además, si la
carpeta que se subía contenía un `.git` (lo que efectivamente pasó), había riesgo
de exponer el historial del repo.

**El arreglo.** `index.html` se movió a `public/` y:

```toml
[build]
  publish = "public"
```

Solo se publica lo que va al navegador. `README-DEPLOY.md`, `docs/`, `package.json`,
`test/` y las funciones quedan afuera del deploy.

De paso se agregaron headers de seguridad (`X-Frame-Options: DENY`,
`nosniff`, `Referrer-Policy`) y `Cache-Control: no-cache` en el HTML, para que un
deploy nuevo llegue al cliente en el próximo refresh y no quede pegado a una
versión vieja.

---

## 🟡 5. Safari borraba el perfil del cliente cada 7 días

**El error.** El perfil (Manual + Oferta + encuesta) vivía **solo** en
`localStorage`. El README lo trataba como una molestia menor —*"si cambia de
dispositivo, vuelve a pegar su identidad (2 min)"*— pero es peor: **Safari borra
el localStorage escrito por JavaScript después de 7 días sin visitar el sitio.**
Un cliente de iPhone que usa Synoma cada dos semanas tenía que volver a pegar
tres documentos largos cada vez. Y vos no tenías copia.

**El arreglo.** Función nueva `netlify/functions/perfil.js` que guarda un
respaldo en Netlify Blobs, indexado por código:

```
GET  /api/perfil?code=FND-ANA1   → { profile }
PUT  /api/perfil                 → { ok: true }
```

El localStorage sigue siendo la copia rápida local; el respaldo es la red de
seguridad. El flujo nuevo:

- **Al guardar la identidad:** se sube el respaldo en segundo plano, sin hacer
  esperar al cliente.
- **Al entrar sin perfil local:** antes de mandarlo a pegar todo de nuevo, se
  busca el respaldo. Si está, entra directo al dashboard.

Se rechaza guardar un perfil vacío, para que alguien que abre la pantalla de
identidad y guarda sin pegar nada no le pise el respaldo bueno con vacío.

**Nota de privacidad, para que sea una decisión y no un accidente:** el perfil ya
salía del navegador en cada mensaje (va dentro del prompt hacia la API de
Claude), así que guardarlo en tu cuenta de Netlify no agrega una exposición
nueva. Pero sí te vuelve responsable de esos datos: son documentos de negocio de
tus clientes. Si preferís no guardarlos, borrá `netlify/functions/perfil.js` y
las funciones `fetchBackup` / `saveBackup` de `public/index.html`.

---

## 🟡 6. Un pico de carga en la API se le mostraba al cliente como una falla

**El error.** La función llamaba a la API con `fetch` crudo y sin reintentos. Un
429 (rate limit) o un 529 (sobrecargado) —ambos transitorios y esperables— se
convertían en "el motor está ocupado, probá de nuevo en un minuto".

**El arreglo.** Reintentos con backoff exponencial, respetando el header
`retry-after` cuando viene:

```js
const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
if (retryable && attempt < MAX_ATTEMPTS - 1) {
  const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 8000)
                                : 2 ** attempt * 1000 + Math.random() * 500;
  await new Promise(r => setTimeout(r, waitMs));
  return callClaude({ ...arguments[0], attempt: attempt + 1 });
}
```

Hasta 3 intentos. Un 400 **no** se reintenta: eso es un error nuestro, no algo
transitorio, y reintentarlo solo gasta tiempo.

(Esto es lo que el SDK oficial de Anthropic hace solo. Se mantuvo `fetch` crudo
para no arrastrar `node_modules` a la función, pero entonces hay que escribirlo.)

**Tests:** `reintenta un 529`, `reintenta un 429`, `un 400 NO se reintenta`, `si
se agotan los reintentos devuelve 502 upstream_error, no not_configured`.

---

## 🟡 7. Se reenviaba el perfil completo a precio lleno en cada mensaje

**El error.** No es un bug, es dinero tirado. Cada mensaje reenviaba el prompt
del sistema (~1.500 tokens) **más el perfil entero del cliente** (~6.000 tokens)
pagando entrada a precio completo. Ese bloque no cambia nunca dentro de una
sesión.

**El arreglo.** Prompt caching, con el system partido en dos bloques según qué
tan estable es cada uno:

```js
const system = [
  { type:'text', text: SYSTEM_BASE,            cache_control:{type:'ephemeral'} }, // igual para todos
  { type:'text', text: profileBlock(profile),  cache_control:{type:'ephemeral'} }, // estable por cliente
];
```

El bloque 1 se cachea a nivel global (todos los clientes comparten el mismo
prompt base); el bloque 2 por cliente. Las lecturas de caché cuestan el **10%**
del precio normal de entrada.

| | Entrada | Salida | Total |
|---|---|---|---|
| Antes | ~10.000 tokens = 0,030 USD | 0,030 USD | **~0,060 USD** |
| Ahora | 0,002 + 0,009 USD | 0,030 USD | **~0,041 USD** |

~30% menos por mensaje. La salida es el piso: bajarla requiere respuestas más
cortas, no optimización técnica.

**Detalle que importa:** el caché se compara por prefijo exacto y se invalida con
**un solo byte** de diferencia. Por eso `SYSTEM_BASE` se movió a su propio módulo
(`netlify/functions/_prompt.js`) como constante, sin nada dinámico interpolado.
Si le metés una fecha o un nombre adentro, el caché deja de funcionar en silencio
—sin error, solo más caro.

**Tests:** `el system va en dos bloques, ambos con cache_control`, `el bloque
base es byte-idéntico entre clientes distintos (si no, no cachea)`.

---

## ⚪ 8. Arreglos menores

| Error | Arreglo |
|---|---|
| Sin `package.json` → versión de Node sin fijar; el código usa `fetch` global (Node 18+) y un cambio de default en Netlify lo rompía sin aviso. | `package.json` con `engines.node >= 20` y `NODE_VERSION = "20"` en `netlify.toml`. |
| Sin visibilidad: no había forma de saber si los clientes estaban pegando contra errores. | `console.error` en todas las rutas de fallo y `console.log` del `usage` de tokens por código en cada respuesta. Queda en los logs de Netlify: sirve para ver el costo real por cliente y cuánto ahorró el caché. |
| Doble envío: apretar Enter dos veces rápido disparaba dos peticiones. | Flag `SENDING` y el botón Enviar se deshabilita mientras responde. |
| Un `role` inesperado en el historial podía romper la petición a la API. | Los roles se normalizan: cualquier cosa que no sea `assistant` pasa a `user`. |
| El prompt del sistema estaba enterrado en medio del código de red. | Movido a `netlify/functions/_prompt.js`, verificado byte por byte contra el original. Ahora se puede editar el prompt sin tocar el código. |

---

## 🟢 9. El chat se perdía al cerrar la pestaña

**El error.** Las tablas `conversaciones` y `mensajes` existían desde el esquema
inicial, pero nadie escribía en ellas: el historial vivía solo en una variable de
JavaScript. Cerrás la pestaña y Synoma se olvida de todo.

Eso convertía la app en un **paso atrás** respecto del Proyecto de ChatGPT que
los clientes ya venían usando, donde el hilo queda. Y rompía `/racha`, que está
diseñado alrededor de "¿qué publicaste de lo que planificamos la semana pasada?".

**El arreglo.** El historial vive en la base, colgado del cliente
(`_conversacion.js`). Un hilo continuo por persona, igual que un Proyecto de
ChatGPT — no pestañas de conversación, que sería pedirle que administre algo que
hoy no administra.

Tres consecuencias concretas:

- Entra desde el teléfono y sigue la conversación que dejó en la computadora.
- Safari le limpia el navegador y no pierde nada.
- **El servidor deja de confiar en lo que manda el navegador.** Antes el
  navegador enviaba el historial completo en cada pedido, así que cualquiera
  podía inyectar turnos falsos de `assistant` y hacerle creer a Synoma que ya
  había dicho algo que nunca dijo. Ahora el navegador manda solo la pregunta
  nueva.

```js
// synoma.js — el historial se arma en el servidor
const previos = await historial(cliente.id, MENSAJES_CONTEXTO);
const trimmed = paraElModelo([...previos, { role: 'user', content: pregunta }]);
```

**El turno se guarda cuando la respuesta terminó**, no antes. Si se guardara la
pregunta antes de llamar a Claude, cada llamada fallida dejaría un mensaje
colgado sin respuesta y el pedido siguiente le mandaría al modelo un hilo lleno
de preguntas sin contestar. Si la respuesta se cortó a la mitad se guarda igual
lo que llegó: es lo que el cliente tiene en pantalla, y que el historial diga
otra cosa lo confundiría.

**Privacidad, que era el requisito.** Se guarda para el cliente, no para vos:

| | |
|---|---|
| El cliente ve su chat | ✅ |
| El cliente puede borrarlo entero, cuando quiera | ✅ botón **Borrar chat** |
| Vos ves *cuántos* mensajes tuvo cada uno | ✅ en el panel |
| Vos ves *qué* escribió | ❌ y no hay forma de construirlo sin tocar el código |
| Se borra solo a los 90 días | ✅ `purga.js`, una vez por día |

Hay un test que lee el esquema y falla si alguna vista de admin llega a tocar las
tablas `mensajes` o `conversaciones`. No es una promesa: es una alarma.

---

## 🟢 10. La Fundación: los 8 bloques

**Qué se sumó.** El prompt ahora conoce la estructura de fundación de contenido
—porqué, objetivo, pilares, banco de historias, opiniones fuertes, a quién le
hablás, su mundo interno, voz y posicionamiento— y cinco comandos nuevos para
construirla: `/fundacion`, `/pilares`, `/persona`, `/hottakes`, `/banco`.

**Dónde se guarda.** Un campo nuevo, `perfiles.fundacion`, con su propio tope
(8.000 caracteres, más chico que el del Manual a propósito: son ocho bloques de
pocas líneas, no un documento). Va **primero** en el bloque de perfil que se le
manda al modelo, porque es lo que define pilares, persona y voz.

**La regla que más cambia la salida:** si el cliente vende algo, su oferta es
**un** pilar, no todos. Sin esa regla el modelo propone cinco pilares que son
cinco formas de decir "comprá", y la cuenta queda como un folleto.

**Costo.** `SYSTEM_BASE` creció de ~4.000 a ~6.500 caracteres. Es el prefijo
cacheado, así que el primer mensaje de cada cliente después del deploy paga
precio completo una vez y se recupera en el segundo. Las lecturas de caché
cuestan el 10%.

---

## 🟢 11. El contenido creado se perdía dentro del chat

**El problema.** Synoma genera un guion buenísimo, el cliente lo lee, sigue
trabajando, y a los tres días no lo encuentra. Tiene que volver a pedirlo — y
sale distinto, porque el modelo no es determinista. Guardar la conversación
(punto 9) no alcanza: buscar una pieza dentro de 200 mensajes no es una
biblioteca, es un cajón.

**El arreglo.** Una pantalla nueva, **Mis contenidos**, con una grilla donde cada
pieza es una fila propia (tabla `piezas`).

**Se guardan solas.** El cliente no tiene que apretar nada — que es la parte que
importa, porque el motivo por el que quiere la grilla es justamente que se le
pierden las cosas. Los nueve comandos que producen algo publicable
(`/semana`, `/idea`, `/guion`, `/gancho`, `/historias`, `/venta`, `/post`,
`/repurpose`, `/revisar`) van a la biblioteca con su tipo puesto.

Lo que **no** se guarda solo: `/fundacion`, `/pilares`, `/persona`, `/hottakes`,
`/banco` (eso es identidad y ya tiene su lugar en el perfil) y `/racha` (es un
repaso, no una pieza). Cualquier otra respuesta se puede guardar a mano con un
botón en la burbuja.

**El título.** Sale del argumento del comando cuando lo hay —`/guion cómo elegir
un nutricionista` ya dice qué es la pieza— y si no, de la primera línea con texto
de la respuesta, sin los asteriscos del markdown. Sin ese filtro la mitad de los
títulos serían `---`.

**El estado es lo que la vuelve útil.** Cada pieza pasa por
**Sin grabar → Grabada → Publicada**, con un botón por paso. Sin eso la grilla es
un archivo muerto: el cliente no distingue lo que ya publicó de lo que le falta
grabar. También se puede archivar (sale de la vista) o borrar.

**Y con eso `/racha` empieza a funcionar de verdad.** Antes preguntaba "¿qué
publicaste de lo que planificamos?" sin tener con qué contestar, así que le
preguntaba al cliente lo que el sistema ya podía saber. Ahora, **solo cuando el
mensaje es `/racha`**, se le manda al modelo un tercer bloque con el listado: qué
produjo, qué publicó, qué quedó sin grabar y en qué fecha.

```js
// synoma.js — el bloque se paga solo en /racha, no en cada mensaje
if (/^\/racha\b/i.test(pregunta)) {
  system.push({ type: 'text', text: bloqueDeRacha(await resumenParaRacha(cliente.id)) });
}
```

Ese bloque lleva **títulos y estados, nunca el contenido** de las piezas: mandar
el texto completo de 20 piezas costaría más que la respuesta entera. Y si la
biblioteca está vacía se lo dice explícitamente, con la instrucción de no
inventar un repaso.

**Dos diferencias con el chat, a propósito:**

| | Chat | Biblioteca |
|---|---|---|
| Se borra a los 90 días | sí | **no** |
| Por qué | es andamiaje, se puede tirar | es el activo del cliente |

Las piezas se borran solo si el cliente las borra. Hay un test que lee
`purga.js` y falla si alguna vez llega a tocar la tabla `piezas`.

**Lo que vos ves en el panel:** dos números nuevos —cuántas piezas produjo y
cuántas publicó— y la fecha de la última. Es la métrica de adopción que importa,
porque un cliente que genera y no publica necesita otra conversación que uno que
no genera. Nunca un título ni un contenido: el test del esquema también cubre
esto.

---

## Lo que NO se cambió, y por qué

**Modelo y `max_tokens`.** Se mantuvo `claude-sonnet-5` con 2.500 tokens, que es
la elección correcta. Solo cambiaría si querés respuestas más largas (subir
`MAX_TOKENS`) o más calidad a más costo (Opus 5).

**El prompt original.** Los 13 comandos y las 7 reglas originales están
verbatim, verificados byte por byte. Lo de la Fundación se **sumó**; no se
reescribió nada de lo que ya funcionaba.

**Un solo hilo de conversación por cliente.** El modelo de datos soporta varios
(cada conversación tiene su id), pero la app abre uno. Pestañas de conversación
son más UI de la que este cliente necesita hoy.

**El panel de administrador.** La vista `panel_clientes` está lista en la base y
no tiene pantalla todavía. Va junto con el editor de prompt con versiones y
rollback.

---

## Qué tenés que hacer vos

**En Netlify → Site settings → Environment variables:**

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | tu key de console.anthropic.com |
| `DATABASE_URL` | la URL de la base de Netlify DB. **Tiene que estar cargada como variable**, si no las migraciones no corren en el build y las tablas nunca se crean. |
| `RESEND_API_KEY` | para que el código de acceso llegue por email. Sin esto el código sale por pantalla (modo desarrollo). |
| `EMAIL_REMITENTE` | ej. `Synoma <hola@foundersbs.com>` con el dominio verificado en Resend |
| `GHL_TOKEN` + `GHL_LOCATION_ID` | Private Integration de HighLevel, para verificar quién tiene acceso |
| `GHL_ACTIVE_TAG` | *(opcional)* el tag que habilita. Default `synoma-activo`. |
| `PRECIO_MENSUAL` / `MONEDA` | *(opcional)* default `59` / `USD` |
| `RENOVACION_URL` | a dónde mandar a quien terminó el programa y quiere seguir |
| `SYNOMA_DIAS_RETENCION` | *(opcional)* días que se guarda el chat. Default 90. |
| `SYNOMA_DAILY_LIMIT` | *(opcional)* mensajes por cliente por día. Default 60. |

**Deploy:**

```bash
npm install
npm test              # 132 tests, deberían pasar todos
git push              # Netlify deploya solo
```

Las migraciones (`db/*.sql`) corren solas en cada build, en orden y una sola vez.

**Probar antes de mostrárselo a un cliente:**

1. Entrá con tu email. Tiene que llegarte el código de 6 dígitos **al mail**. Si
   aparece en pantalla, falta `RESEND_API_KEY`.
2. Tocá 📅 **Mi semana**. El texto tiene que aparecer progresivamente. Si ves la
   pastilla de "modo demo", falta la API key.
3. **Cerrá la pestaña, volvé a abrir y entrá.** Tiene que estar tu conversación
   completa. Esto es lo nuevo — si no está, algo falló en las migraciones.
4. Entrá desde el celular con el mismo email. Misma conversación.
5. Escribí `/fundacion`. Tiene que hacerte **una** pregunta, no las ocho juntas.
6. Tocá **Borrar chat**, confirmá, recargá. Tiene que estar vacío, y tu
   identidad y tu Fundación intactas.
7. Pedile un 🎬 **guion**. Abajo de la respuesta tiene que decir "Guardado en Mis
   contenidos". Entrá a **Mis contenidos**: tiene que estar ahí. Tocá
   **Ya la grabé** y después **Ya la publiqué**.
8. Escribí `/racha`. Tiene que nombrarte esa pieza y su estado, no preguntarte
   de cero qué hiciste.
9. Probá con un email que no tenga el tag en GHL. Tiene que ofrecer la
   suscripción, **no** un error.

**Y algo que no es código:** si la key de Anthropic viajó alguna vez por chat o
mail, rotala. Cualquier secreto que pasó por un canal no seguro hay que darlo por
comprometido.
