# Errores encontrados y su arreglo

Cada problema con el arreglo concreto que se aplicó. El detalle del análisis
original está en [`EVALUACION.md`](./EVALUACION.md).

Todo esto está implementado y con tests: `npm test` → 209 tests en verde (200 de servidor + 9 de interfaz en Chromium).

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

## 🔴 12. `/semana` se cortaba a la mitad y no avisaba nada

**Lo que se veía.** `/semana` devolvía un preámbulo largo y después la tabla, que
se cortaba en la fila 2 de 5 — a mitad de palabra. Sin ningún error en pantalla.
El cliente se llevaba dos piezas de un plan de cinco creyendo que era el plan.

**Por qué pasaba.** Netlify corta la función a los 10 segundos (26-30 en los
planes pagos) y **el streaming no exime de ese tope**: cuenta la duración total
de la invocación, no el tiempo hasta el primer byte. A 60-80 tokens por segundo,
26 segundos son unos 2.000 tokens de salida. Una tabla de 8 columnas × 5 filas
con un preámbulo por delante no entra.

**Lo peor no era el corte, era el silencio.** La API avisa por qué dejó de
escribir (`stop_reason`) y nosotros lo tirábamos a la basura, así que una
respuesta truncada llegaba al navegador indistinguible de una completa.

**El arreglo, en cuatro partes.**

*Uno — se detecta el corte y se avisa.*

```js
if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
...
emit({ type: 'done', usage, truncada: stopReason === 'max_tokens', duracion_ms });
```

En pantalla aparece un aviso ámbar: *"✂️ Esta respuesta quedó cortada por el
largo"*, con un botón **Continuar desde donde quedó**. Y como el historial ahora
vive en el servidor (punto 9), Synoma sabe exactamente dónde se cortó: sigue sin
repetir nada.

*Dos — se acorta la salida en lugar de agrandar el tope.* Subir `MAX_TOKENS` no
arregla nada: solo cambia "se cortó por largo" (recuperable) por "se cortó la
conexión" (se pierde todo). Lo que se cambió es el formato: `/semana` ahora
arranca **directo con la tabla**, sin preámbulo, con celdas cortas y columnas
fijas. Los avisos van después, en dos líneas.

*Tres — queda registrado cuál de los dos topes fue.* El log deja
`stop_reason` y la duración en milisegundos. Es lo que permite distinguir "se
cortó por tokens" de "lo mató el tope de tiempo de Netlify", que desde el
navegador se ven igual y se arreglan distinto.

*Cuatro — si aun así se corta*, la salida es mover `/api/synoma` a Netlify Edge
Functions, que están hechas para streaming largo. No se hizo ahora porque es un
cambio de runtime (Deno) que no se puede validar sin deploy, y con 100 clientes
adentro no se toca a ciegas. El log de arriba dice si hace falta.

---

## 🔴 13. El modelo no sabía qué día era

**Lo que se veía**, textual, en una respuesta real de `/semana`:

> *"la pieza de '151 días' queda con fecha pendiente de confirmar — no la grabes
> hasta que me digas qué día es hoy"*

**Por qué.** Nunca le pasamos la fecha. Un modelo de lenguaje no tiene reloj: sin
que se la digas, o pregunta, o inventa una cuenta de días mal hecha.

**El arreglo.** Un bloque de sistema con la fecha de hoy en la zona horaria del
cliente (`America/Argentina/Buenos_Aires` por defecto, configurable con
`SYNOMA_ZONA_HORARIA`), con la instrucción explícita de no preguntarla nunca.

Va **sin `cache_control`** a propósito: cambia todos los días, y si fuera parte
del prefijo cacheado invalidaría el caché de los 100 clientes cada medianoche.

---

## 🟢 14. El plan semanal como calendario descargable

**El problema.** La tabla se lee bien en el chat de una computadora. En el
teléfono se lee de costado, y como plan de trabajo no sirve: no entra en la
agenda, no se puede imprimir, no se tilda lo que ya se hizo.

**El arreglo.** El servidor convierte la tabla en datos y de ahí salen tres cosas:

| | Para qué |
|---|---|
| **Vista de calendario** | Una tarjeta por día con el gancho grande, el punteo, el dolor que ataca y los minutos de producción. En el celular se apilan. |
| **`.ics`** | Se importa a Google Calendar, al iPhone y a Outlook. Cada pieza queda como evento de día completo con el gancho y el punteo en la descripción. |
| **`.csv`** | Abre en Excel y en Sheets, con una columna "Publicada" vacía para tildar. |

**Las fechas no las calcula el modelo.** El modelo escribe solo el día de la
semana (`Lun`); la fecha real la calcula el servidor desde el día en que se
generó el plan. Los modelos de lenguaje son malos con aritmética de fechas —el
punto 13 es la prueba— y una fecha mal calculada dentro de un archivo que se
importa a la agenda es peor que no tener el archivo.

Y se calculan desde la fecha de creación del plan, no desde hoy: si el cliente
abre en septiembre un plan de agosto, tiene que ver agosto.

**Tres detalles que parecen menores y no lo son:**

- El `.ics` va plegado a 75 caracteres con CRLF, como pide el RFC 5545. Sin
  plegar, Outlook descarta el evento entero sin avisar.
- El `.csv` arranca con BOM. Sin él, Excel en Windows muestra "Miércoles" roto.
- Una celda que empieza con `=`, `+`, `-` o `@` se escapa: Excel la interpretaría
  como fórmula, y un gancho que arranca con un guion es normal en este producto.

**Si el modelo se sale del formato**, el endpoint devuelve 422 y la app sigue
mostrando el texto plano con un mensaje que dice qué hacer. Un plan que no se
puede convertir a calendario sigue siendo un plan.

**Dos bugs propios que encontraron los tests**, y valen la pena porque los dos
eran silenciosos:

1. `"Sin venta"` se clasificaba como **venta** — buscar `vent` sin más marcaba
   como venta justo las piezas que no lo eran, y el calendario mostraba cinco
   piezas vendiendo cuando había tres educativas.
2. `dijo "esto"` quedaba como `dijo "esto` — la limpieza de comillas cortaba la
   de cierre, dejando una comilla sin cerrar en el título del evento.

---

## 🔴 15. Un error inesperado llegaba sin identificarse

**Lo que se veía.** Dos pantallas distintas, en dos días distintos:

> ⚠️ El motor devolvió una respuesta vacía. Probá de nuevo.
> ⚠️ No se pudo contactar al motor.

Ninguna de las dos servía para nada. La segunda es peor: es **literalmente el
mismo mensaje que sale si se corta el wifi**. No había forma de saber si el
problema estaba en el código, en el deploy, en Netlify o en la conexión.

**La causa raíz del segundo caso, y es un error propio.** El reintento automático
de respuestas vacías (punto anterior) no miraba el reloj. Si el primer intento se
comía 12 segundos y volvía vacío, el segundo empujaba el total por encima del tope
de Netlify → la plataforma mataba la función → 502 con una página HTML → el
navegador no podía leer ni el código ni el motivo. **Un arreglo pensado para que
el cliente no viera un error le causaba uno peor y menos diagnosticable.**

Ahora el reintento tiene presupuesto de tiempo, medido desde el arranque del
pedido y no desde el arranque del stream — porque lo que Netlify corta es la
invocación completa, incluida la espera hasta el primer token. Pasados 7 segundos
ya no hay lugar para otra llamada: se informa el problema, que es recuperable, en
lugar de arriesgar el 502.

**Y tres cosas para que esto no vuelva a ser un diagnóstico a ciegas.**

*Uno — todos los endpoints quedan blindados* (`_http.js`). Cualquier excepción no
prevista sale como JSON con código `error_interno` y el stack completo va al log.
Nunca más una página de error de Netlify llegando al navegador.

*Dos — el navegador muestra el número de estado* cuando la respuesta no es JSON.
Ese número es todo:

| Código | Qué significa |
|---|---|
| 404 | la función no está publicada — problema de deploy |
| 500 | se rompió el código |
| 502 / 504 | tardó más que el tope de Netlify |

Los tres se veían idénticos antes. Cada uno se arregla distinto.

*Tres — un test de humo* (`test/humo.test.mjs`) que recorre TODOS los endpoints
con la base caída, por cada método HTTP, y falla si alguno responde algo que no
sea JSON con un código legible. También verifica que ninguna respuesta filtre la
API key ni la contraseña de la base.

Ese test existe por una lección concreta de este proyecto: hubo un bug donde
faltaba un `import` en `_email.js`. `node --check` pasaba —la sintaxis era
válida— y ninguna prueba tocaba esa rama, así que iba a explotar exactamente el
día que se conectara el envío de emails, con clientes esperando el código.
**Verificar la sintaxis no es verificar que el módulo corre.**

**Dos arreglos más que salieron de buscar esto:**

- **Doble cierre del stream.** En la rama de error se llamaba `controller.close()`
  y el `finally` volvía a llamarlo. El segundo tira `TypeError`. Node se lo come,
  así que no era la causa de lo que veíamos, pero en otro runtime rompe la
  respuesta entera.
- **`bloqueDeFecha()` podía tumbar la función.** `Intl` tira `RangeError` si el
  runtime no trae la base de zonas horarias completa. Un bloque informativo no
  puede voltear todo el pedido: ahora cae a UTC y avisa en el log.

**Dos perillas nuevas, para no depender de un deploy si vuelve a pasar:**

| Variable | Para qué |
|---|---|
| `SYNOMA_MAX_TOKENS` | bajar el largo de las respuestas si algo se sigue cortando |
| `SYNOMA_MS_REINTENTO` | cuánto tiempo puede quedar antes de descartar el reintento |

---

## 🔴 16. El 504: un plan semanal no cabe en una invocación de Netlify

**El diagnóstico, por fin con un número.** Después de dos rondas a ciegas, el
mensaje trajo el código: **504**. No era el código ni el deploy. Era el tope de
tiempo de la plataforma.

**Y la cuenta que había que hacer antes:**

```
2.200 tokens ÷ ~60 tokens/segundo = 37 segundos
Tope de Netlify:                     10 s  (26-30 si te lo suben)
```

**Un plan semanal completo no cabe en una sola invocación. Punto.** Bajar
`MAX_TOKENS` no lo arregla: lo achica hasta que deja de ser un plan.

**El arreglo: partir la respuesta, no acortarla.**

`MAX_TOKENS` baja a **900** (unos 12 segundos de generación, que sí entran) y
cuando la respuesta queda cortada **el navegador pide el resto solo** y lo pega en
la misma burbuja. El cliente ve una respuesta larga que va apareciendo; abajo son
tres o cuatro pedidos cortos, cada uno dentro del tope. Como el historial vive en
el servidor (punto 9), la continuación arranca justo donde quedó sin repetir nada.

Hay un límite de 4 tramos para que un modelo que no sabe terminar no genere
pedidos para siempre. Al llegar ahí queda el botón manual.

**Tres piezas más, cada una tapando un agujero distinto:**

*Uno — cortamos nosotros antes que Netlify.* Un deadline interno
(`SYNOMA_DEADLINE_MS`, 8,5 s por defecto) para la diferencia entre dos finales muy
distintos:

| | Resultado |
|---|---|
| Cortamos nosotros | el cliente tiene el texto que llegó, queda guardado, y sigue solo |
| Corta Netlify | 504, se pierde TODO, y ni siquiera es JSON |

*Dos — un byte de entrada (`ping`).* Se manda antes de esperar a Claude, para que
la plataforma abra las cabeceras HTTP ya. Sin eso, si el modelo tarda en arrancar
—y tarda más cuanto más grande es el prompt— Netlify puede matar la función antes
de haber mandado una sola cabecera: entonces reemplaza toda la respuesta por un
504 en HTML y el navegador no puede leer nada. Con la conexión abierta, lo peor
que pasa es perder el final.

*Tres — se mide el tiempo hasta la primera palabra aparte del total.* En el log:

```
[synoma] ok · ttft=2100ms total=9400ms · 3800 caracteres
```

Si lo que se come el presupuesto es el `ttft`, el problema es el tamaño del prompt
o que el caché no pegó. Si es el total, es cuánto escribe el modelo. Son arreglos
distintos y desde el navegador se veían igual.

**La continuación se le pega a la MISMA pieza de la biblioteca**
(`ampliarPieza`). Sin eso, la biblioteca del cliente quedaría con "Plan semanal
(1 de 3)", "(2 de 3)"… en lugar de un plan.

---

## 🟢 17. El chat dejó de ser un muro de texto

**El pedido, textual:** *"en todo caso que se cree en la biblioteca directamente,
y que el msj sea 'mirá tu biblioteca' o algo así"*. Tiene razón, y resuelve algo
que el punto anterior dejaba a medias.

**Antes:** cada comando dejaba su contenido completo en el chat. Con cinco
comandos en una sesión, cinco paredes de texto — y encontrar algo, imposible. Que
es exactamente el problema que la biblioteca resuelve: dejar el muro *además* de
guardarlo es no resolverlo.

**Ahora:** mientras se genera, el texto se ve aparecer (para que haya señal de
vida). Cuando termina, la burbuja se convierte en una tarjeta corta:

> 📅 **PLAN SEMANAL · GUARDADO**
> Tu semana del 4 al 10
> *Está en 📚 Mis contenidos. Miralo como calendario y bajátelo a tu agenda.*
> **[📅 Ver mi calendario]** **[📚 Mirá tu biblioteca]** [Ver el texto acá]

El texto no se pierde: queda a un toque en "Ver el texto acá". Y para un plan, el
botón principal lleva al calendario, que es su forma útil — no al texto.

---

## 🔴 18. El peor de todos: la pantalla en blanco

**Lo que se veía al pedir la semana: NADA.** Ni texto, ni error, ni aviso. Los 200
tests del servidor pasaban.

**Y era consecuencia directa del arreglo anterior.** El `ping` que se agregó para
que la plataforma abriera las cabeceras HTTP funcionó *demasiado* bien: ahora el
navegador recibe un 200 y la conexión queda abierta. Cuando Netlify mata la
función a mitad de camino, el stream **simplemente se termina**, sin evento de
cierre y sin error. El navegador leía el `ping`, no tenía nada que mostrar, y se
quedaba callado.

O sea: convertí un "504 con mensaje" en un "200 en silencio". Peor, porque el
cliente no sabe si esperar, reintentar o avisar.

**El arreglo, en dos lados.**

*En el navegador — no confiar en que el stream cerró bien:*

```js
let vioDone = false;
// ... en el bucle: if(ev.type === 'done') vioDone = true;
if(!vioDone) throw { code: 'corte_plataforma', ... };
```

Si llegó texto, se conserva y se ofrece continuar. Si no llegó nada, sale un
mensaje claro con botón de reintentar.

*En el servidor — avisar antes de que nos maten:* el deadline interno ya no exige
que haya texto. Si el modelo no dijo una palabra dentro del presupuesto, se corta
y se manda un error explícito (`demasiado_lento`). Es un caso distinto de "quedó
cortada" y merece otro mensaje: no hay nada que continuar.

---

## 🟢 19. Tests de interfaz, en un navegador de verdad

Este bug es la razón por la que existe `test/ui.test.mjs`.

Ningún test de servidor podía verlo: el fallo estaba en **cómo el navegador
interpreta un stream que se termina sin cerrar**. Así que ahora los casos críticos
se prueban abriendo la app en Chromium con la API simulada.

Los nueve casos, y cada uno está por algo que ya pasó o que dolería mucho:

| Caso | Qué protege |
|---|---|
| Stream cortado sin una palabra | **el bug de arriba** — nunca más pantalla en blanco |
| Stream cortado con texto a medias | que lo que llegó se conserve y se pueda seguir |
| Respuesta vacía del motor | que salga mensaje y botón, no silencio |
| Respuesta completa | que la burbuja se convierta en la tarjeta de la biblioteca |
| "Ver el texto acá" | que el texto completo no se haya perdido |
| Continuación automática | que se complete sola, en la MISMA burbuja |
| Id de pieza en la continuación | que la biblioteca no quede con "(1 de 3)", "(2 de 3)"… |
| Tope de tramos | que un modelo que no termina no pida para siempre |
| Error del servidor | que el mensaje llegue a la pantalla |

**Se verificó que el test tiene dientes**, que es la parte que suele saltearse: se
corrió contra la versión sin el arreglo y da 0 burbujas. Un test que no falla con
el código roto no sirve para nada.

Se saltean solos si no hay Chromium o `playwright-core`, así que `npm test` sigue
andando en cualquier máquina. El build de Netlify no los corre (solo corre las
migraciones).

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
| `SYNOMA_ZONA_HORARIA` | *(opcional)* zona para las fechas. Default `America/Argentina/Buenos_Aires`. |
| `SYNOMA_MAX_TOKENS` | *(opcional)* largo de cada tramo de respuesta. Default 900. |
| `SYNOMA_DEADLINE_MS` | *(opcional)* cuándo cortar antes que Netlify. Default 8500. **Si te subieron el tope de funciones a 26 s, poné 22000: van a hacer falta menos vueltas y todo va a salir más rápido.** |
| `SYNOMA_MS_REINTENTO` | *(opcional)* ms de margen para reintentar una respuesta vacía. Default 7000. |

**Deploy:**

```bash
npm install
npm test              # 209 tests, deberían pasar todos
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
9. Pedile un 📅 **plan semanal**. Tiene que arrancar **directo con la tabla**,
   sin presentación. Tocá **📅 Ver como calendario** y después
   **Agregar a mi calendario**: el archivo tiene que importarse a Google Calendar
   con las 5 piezas en sus días.
10. Preguntale "¿qué día es hoy?". Tiene que responder la fecha, no preguntártela.
11. Probá con un email que no tenga el tag en GHL. Tiene que ofrecer la
    suscripción, **no** un error.

**Y algo que no es código:** si la key de Anthropic viajó alguna vez por chat o
mail, rotala. Cualquier secreto que pasó por un canal no seguro hay que darlo por
comprometido.
