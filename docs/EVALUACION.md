# Synoma Founders — Evaluación técnica y de hosting

Fecha: 2026-07-30 · Sobre el commit `eba27e7` ("Synoma Founders v1") de Vicky Becci.

---

## 1. Resumen ejecutivo

**La app son 5 archivos, no 36.** Lo que te enviaron era la carpeta con el `.git` incluido; los otros 31 archivos son plomería interna de git (hooks de ejemplo, índice, objetos). El proyecto real es:

| Archivo | Tamaño | Qué es |
|---|---|---|
| `index.html` | 18 KB | La app completa: login, setup de identidad, dashboard. HTML + CSS + JS en un solo archivo, sin build, sin dependencias. |
| `netlify/functions/synoma.js` | 7 KB | El backend: valida el código del cliente, arma el prompt y llama a la API de Claude. |
| `netlify.toml` | 58 B | Config de Netlify. |
| `README-DEPLOY.md` | 2.8 KB | Guía de deploy para el equipo. |
| `.gitignore` | 39 B | — |

**Netlify es una elección correcta.** Un archivo estático + una función serverless liviana es el caso de uso ideal de Netlify, y el volumen (unos pocos clientes) entra cómodo en el plan gratuito. Mover a Vercel o Cloudflare no resolvería ninguno de los problemas reales.

**Pero hay un bug que hace que la app se vea rota en producción, y no es de hosting.** La función no usa streaming, y una respuesta de 2.000 tokens tarda 30-40 segundos. Netlify corta las funciones síncronas a los 10 segundos (26 s máximo en planes pagos). O sea: **el comando principal, "Mi semana de contenido", va a fallar casi siempre.** Y falla de la peor manera posible: el frontend atrapa cualquier error y entra en "modo demo", mostrando contenido de ejemplo inventado sobre dietas como si fuera el plan del cliente.

Esto se arregla con streaming, no cambiando de hosting.

**Veredicto:** quedate en Netlify. Arreglá 4 cosas (§4). Lo que te va a limitar más adelante no es dónde corre, sino tres decisiones de arquitectura (§5).

---

## 2. Cómo está armada

```
Cliente (navegador)                    Netlify                      API de Claude
┌──────────────────┐          ┌──────────────────────┐         ┌─────────────────┐
│  index.html      │          │  netlify/functions/  │         │                 │
│  · login código  │  POST →  │  synoma.js           │  POST → │  claude-sonnet-5│
│  · setup perfil  │          │  · valida código     │         │                 │
│  · dashboard     │ ← texto  │  · arma system prompt│ ← texto │                 │
│                  │          │  · llama a Claude    │         │                 │
│  localStorage:   │          │                      │         └─────────────────┘
│  código + perfil │          │  env: ANTHROPIC_API_KEY
└──────────────────┘          │       SYNOMA_CODES
                              └──────────────────────┘
```

**Lo que está bien pensado:**

- **La API key nunca toca el navegador.** Correcto. Toda la comunicación con Claude pasa por la función. Esto es lo más importante y está bien resuelto.
- **Sin build step, sin `node_modules`, sin framework.** Es un `.html` y un `.js`. Podés abrir el archivo, cambiar un texto y hacer deploy. Para alguien que quiere mantener esto sin ser programador, esto es un activo real, no una limitación.
- **El system prompt es el corazón del producto y está muy bien construido.** Los 13 comandos (`/semana`, `/guion`, `/gancho`…), las reglas anti-genérico, la mezcla 3 educativas / 2 de venta, la instrucción de usar las frases textuales de la encuesta. Ese prompt es la propiedad intelectual acá — el código alrededor es andamiaje.
- **El modelo es el adecuado.** `claude-sonnet-5` es la elección correcta para este caso: buena calidad de escritura a un tercio del costo de Opus.

---

## 3. Los problemas reales, en orden de gravedad

### 🔴 1. Timeout + "modo demo" silencioso — la app se ve rota

`netlify/functions/synoma.js:76` pide `max_tokens: 2500` **sin streaming**. Una respuesta de ese tamaño tarda 30-40 segundos en generarse. Netlify corta a los 10 segundos por defecto.

Y en `index.html:289-294`:

```js
}catch(e){
  $('demo-pill').style.display='block';
  const demo = demoReply(text);
  ...
}
```

Cualquier error —incluido el timeout— cae en el `catch` y muestra `demoReply()`. Para `/semana`, eso devuelve un plan de ejemplo hardcodeado sobre **dietas y nutrición** (`index.html:299`). Si tu cliente es nutricionista, no se va a dar cuenta de que es falso. Si es abogado, va a pensar que la herramienta está rota.

Tres consecuencias:

1. El comando estrella no funciona.
2. Cuando no funciona, el cliente recibe contenido inventado presentado como propio.
3. Vos no te enterás: no hay logging, ni alertas, ni forma de saber cuántos clientes están pegando contra esto.

**Arreglo:** reescribir la función con streaming (Netlify Functions 2.0 — `export default async (req) => new Response(stream)` en lugar de `exports.handler`), y hacer que el modo demo se active **solo** cuando el backend responde explícitamente que no está configurado, nunca ante un error genérico. Un error debe verse como un error.

> Nota: el formato actual `exports.handler` que devuelve `{statusCode, body}` **no puede** hacer streaming. Es una reescritura de la función, no un flag. Conviene verificar los límites de timeout vigentes para tu plan de Netlify antes de decidir.

### 🟠 2. La API key está expuesta a abuso

Tres cosas se combinan mal:

- `Access-Control-Allow-Origin: '*'` (`synoma.js:44`) — la función se puede llamar desde **cualquier** sitio web, no solo desde el tuyo.
- El único control de acceso es una lista de códigos compartidos en una variable de entorno. Un código no identifica a una persona: se puede pasar por WhatsApp y funciona igual.
- **No hay rate limiting.** Nada impide 10.000 llamadas por hora.

Un código filtrado = consumo ilimitado de tu key de Anthropic, desde cualquier lado, sin forma de saber quién. No es un problema teórico: el código es corto (`FND-XXXX`) y viaja por Telegram.

**Arreglo mínimo:** limitar el CORS a tu dominio, y agregar un tope de mensajes por código y por día (Netlify Blobs sirve para llevar la cuenta, sin base de datos).

### 🟠 3. `publish = "."` publica archivos internos

`netlify.toml` publica **toda la carpeta raíz**. Eso incluye `README-DEPLOY.md`, que queda accesible en `https://synoma.foundersbs.com/README-DEPLOY.md` para cualquiera. Ese archivo dice: quién compró la key de la API, el formato de los códigos de acceso, el costo por cliente y el proceso interno del equipo.

Además, si la carpeta que se sube contiene un `.git` (que es exactamente lo que pasó cuando me enviaste el proyecto), hay riesgo de exponer el historial del repo.

**Arreglo:** mover `index.html` a una carpeta `public/` y poner `publish = "public"`. Los archivos internos quedan afuera del deploy.

### 🟡 4. El perfil vive solo en el navegador — y se puede borrar solo

El README dice: *"Si cambia de dispositivo, vuelve a pegar su identidad (2 min)."* Es más frágil que eso:

- Safari (iPhone y Mac) **borra el localStorage escrito por JavaScript después de 7 días sin visitar el sitio.** Un cliente que usa Synoma cada dos semanas desde el iPhone va a tener que volver a pegar su Manual, su Oferta y su encuesta **cada vez**.
- Limpiar caché, modo incógnito o cambiar de navegador = perfil perdido.
- Vos no tenés copia. Si el cliente pierde el perfil, se rehace desde cero.

Pegar tres documentos largos no son 2 minutos, y hacerlo repetidamente es la clase de fricción que hace que la gente abandone una herramienta.

### 🟡 5. Las conversaciones no se guardan

`HISTORY` (`index.html:224`) vive en memoria. Un refresh de página y se pierde toda la conversación. El cliente genera su plan semanal, cierra la pestaña sin copiar, y no hay forma de recuperarlo. Tampoco funciona `/racha` como se pretende (`"repaso semanal: preguntá qué publicó de lo planificado"`) porque no hay historial que consultar.

### 🟡 6. Alta y baja de clientes requiere redeploy

El README dice *"El acceso muere al instante"*. No es exacto: hay que editar la variable `SYNOMA_CODES` en Netlify **y hacer un redeploy** para que tome el cambio. Cada alta y cada baja es una operación manual en el panel de Netlify. Con 5 clientes es tolerable; con 30 es una fuente de errores.

### ⚪ 7. Detalles menores

- **Sin `package.json`** → no hay versión de Node fijada. El código usa `fetch` global (Node 18+), que hoy funciona, pero un cambio de default en Netlify lo rompería sin aviso.
- **Sin retries.** La función llama a la API con `fetch` crudo. Si Anthropic devuelve un 429 (rate limit) o un 529 (sobrecargado), la app muestra "el motor está ocupado" y listo. El SDK oficial de Anthropic reintenta automáticamente esos casos; `fetch` crudo no. (Usar `fetch` en vez del SDK es una decisión defendible acá — evita `node_modules` — pero se pierde eso.)
- **El escapado de HTML está bien.** `index.html:259` escapa `&` y `<` antes de insertar, y solo permite `**negrita**` y saltos de línea. No hay riesgo de XSS.
- **Sin prompt caching.** Ver §6 — es el ahorro más grande disponible.

---

## 4. Netlify vs. las alternativas

La pregunta era si conviene correrlo ahí o en otro lado. Respuesta corta: **ahí está bien.**

| Opción | Encaje | Costo a este volumen | Esfuerzo de migración | Cuándo tendría sentido |
|---|---|---|---|---|
| **Netlify** (actual) | ✅ Estático + 1 función es el caso ideal. Soporta streaming vía Functions 2.0. Netlify Blobs cubre almacenamiento simple sin base de datos. | Gratis (125k invocaciones/mes) | — | **Ahora.** |
| **Vercel** | ✅ Misma forma, streaming de primera clase. | Gratis | Bajo (1-2 h) | Solo si ya usás Vercel para otra cosa. No resuelve nada nuevo. |
| **Cloudflare Workers** | ✅✅ Lo mejor para un proxy de streaming como este. KV/D1 para perfiles, Durable Objects para rate limiting. | Gratis, y el más barato al escalar. | Medio (4-8 h) — modelo de dev distinto | Si esto crece a decenas de clientes y querés perfiles guardados + límites por cliente sin montar servidor. |
| **Railway / Render / Fly** | ⚠️ Servidor real: sin límites de timeout, Postgres incluido. Sobredimensionado hoy. | ~5-20 USD/mes | Medio-alto | Si el roadmap incluye cuentas reales, panel de admin, historial guardado. |
| **VPS propio** | ❌ Máximo control, máximo mantenimiento (parches, TLS, backups, monitoreo). | ~5-10 USD/mes + tu tiempo | Alto | No, para esto. |
| **GHL** | ❌ No ejecuta backends. | — | — | El README tiene razón: GHL sirve para el DNS del subdominio y el custom field con el código. Nada más. |

**El punto clave:** ninguno de los 6 problemas de la §3 se resuelve cambiando de hosting. El timeout se resuelve con streaming (que Netlify soporta). El abuso de la key se resuelve con CORS + rate limiting (igual en cualquier plataforma). El perfil en localStorage se resuelve guardándolo en algún lado — y Netlify Blobs alcanza. Migrar sería trabajo sin retorno.

---

## 5. Lo que realmente te va a limitar

Tres decisiones de arquitectura, independientes del hosting. Ninguna es un error para un v1; todas se van a volver un problema si esto crece.

1. **Códigos en variable de entorno.** No hay identidad de usuario, no hay expiración, no hay uso por cliente, y cada cambio pide un redeploy. El techo son ~10-15 clientes antes de volverse molesto.
2. **Perfil en el navegador.** Es el punto más frágil del producto de cara al cliente (ver §3.4). Y significa que vos no tenés visibilidad: no sabés quién cargó su identidad ni cuán completa está.
3. **Sin persistencia de conversaciones.** Además de la pérdida de trabajo, imposibilita medir uso, entender qué comandos sirven, y hacer funcionar `/racha` como fue diseñado.

Los tres se resuelven con lo mismo: una base de datos mínima (una tabla de clientes, una de perfiles, una de mensajes). Eso es lo que definiría una v2 — y es el momento en que la pregunta de hosting sí vuelve a estar abierta.

---

## 6. Costos — y el ahorro que está sobre la mesa

Precios de `claude-sonnet-5`: **3 USD por millón de tokens de entrada, 15 USD por millón de salida.** Hay precio introductorio de 2/10 USD **hasta el 31 de agosto de 2026** — o sea que en septiembre vas a ver el costo subir ~50% sin que nada cambie en la app. Tenelo previsto.

Por mensaje, con un perfil cargado de tamaño realista (~20.000 caracteres):

| | Entrada | Salida | Total |
|---|---|---|---|
| **Hoy, sin caching** | ~10.000 tokens = 0,030 USD | ~2.000 tokens = 0,030 USD | **~0,060 USD** |
| **Con prompt caching** | 0,002 + 0,009 USD | 0,030 USD | **~0,041 USD** |

Por cliente activo y por mes:

| Uso | Sin caching | Con caching |
|---|---|---|
| Liviano (30 mensajes) | ~1,80 USD | ~1,25 USD |
| Normal (60 mensajes) | ~3,60 USD | ~2,50 USD |
| Intenso (150 mensajes) | ~9,00 USD | ~6,20 USD |

**La estimación del README (1-3 USD por cliente/mes) es razonable** para uso liviano a normal. Se pasa con clientes intensos.

### El prompt caching es el ahorro que falta

Hoy, cada mensaje reenvía el system prompt completo (~1.500 tokens) **más el perfil entero del cliente** (~6.000 tokens) a precio lleno. Ese bloque no cambia nunca dentro de una sesión.

Con `cache_control` sobre ese bloque, las lecturas cuestan **10% del precio normal**. Reduce la entrada un ~90% y el total un ~30%. Es un cambio de pocas líneas en `synoma.js` y no toca el frontend.

(El mínimo cacheable en Sonnet 5 es 1.024 tokens — el bloque system + perfil lo supera con holgura, así que califica.)

**Nota:** el costo de salida es el piso. Bajarlo requiere respuestas más cortas, no optimización técnica.

---

## 7. Plan recomendado

**Antes de mostrárselo a un cliente** (esto no es opcional — hoy el comando principal falla):

1. **Streaming en la función.** Reescribir `synoma.js` a Netlify Functions 2.0 con respuesta en streaming. Arregla el timeout y además el cliente ve el texto aparecer en vez de esperar 40 segundos en blanco.
2. **Matar el modo demo silencioso.** Que se active solo con una señal explícita del backend. Un error tiene que verse como un error.
3. **`publish = "public"`.** Mover `index.html` a `public/` para no publicar los archivos internos.
4. **CORS a tu dominio + tope de mensajes por código.**

**Enseguida después:**

5. **Prompt caching** — 30% menos de costo, cambio chico.
6. **`package.json`** con la versión de Node fijada.
7. **Logging de errores** para que sepas cuando algo falla.

**Cuando pase de ~10 clientes (v2):**

8. Base de datos: clientes, perfiles, conversaciones. Resuelve los tres límites de la §5 de una vez.
9. Panel simple de alta/baja de clientes, sin redeploy.

---

## 8. Cosas pendientes de esta evaluación

- **El chat con Claude Code no llegó.** El archivo `docs/chat-original.md` que subiste quedó siendo una copia idéntica del `README-DEPLOY.md`. Ese chat tiene el razonamiento detrás de las decisiones y vale para entender qué se descartó y por qué. Si lo tenés, súbelo y lo reviso.
- **Verificar los límites de timeout** de funciones vigentes en tu plan de Netlify antes de implementar el punto 1.
- **Si el proveedor te pasó la key de Anthropic por chat o mail, rotala.** Cualquier secreto que viajó por un canal no seguro hay que darlo por comprometido. Se hace en console.anthropic.com y después se actualiza la variable en Netlify.
