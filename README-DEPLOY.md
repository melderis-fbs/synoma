# Synoma Founders — Guía de deploy (para el equipo)

> ⚠️ **Este archivo no se publica.** Vive fuera de `public/`, que es la única
> carpeta que Netlify sirve. No lo muevas ahí: nombra la key de la API, el
> formato de los códigos y los costos.

## Qué es
App web para clientes: entran con un código único, cargan su identidad (Manual + Oferta + encuesta) una sola vez, y usan el dashboard de comandos para crear su contenido con IA — con la voz y la oferta de cada cliente.

## Arquitectura
- `public/index.html` — la app completa (login por código → setup de identidad → dashboard). Es lo único que se publica.
- `netlify/functions/_prompt.js` — el prompt del sistema. **Esto es el producto**; se puede editar sin tocar el código.
- `netlify/functions/synoma.js` — backend serverless: valida el código, arma el prompt con el perfil del cliente y hace streaming de la respuesta de Claude. **La API key nunca toca el navegador.**
- `netlify/functions/perfil.js` — respalda el perfil del cliente en Netlify Blobs, para que no se pierda si el navegador borra el localStorage.
- El perfil se guarda en el navegador del cliente (localStorage) **y** con respaldo en el servidor.
- El "modo demo" se activa **solo** cuando falta configurar la API en el servidor. Cualquier otro error se muestra como error — nunca como contenido de ejemplo.

## Deploy en Netlify

```bash
npm install -g netlify-cli   # una sola vez
netlify login

npm install
npm test                     # 28 tests, tienen que pasar todos
netlify init                 # solo la primera vez (crear sitio, ej. synoma-founders)
netlify deploy --prod
```

⚠️ Netlify **Drop** (arrastrar la carpeta) NO sirve: no soporta funciones. Usá la CLI o conectá el repo de Git.

### Variables de entorno (Netlify → Site settings → Environment variables)

| Variable | Requerida | Valor |
|---|---|---|
| `ANTHROPIC_API_KEY` | sí | La key de console.anthropic.com. |
| `SYNOMA_CODES` | sí | Códigos separados por coma: `FND-ANA1,FND-LUZ2,FND-PAB3` |
| `SYNOMA_DAILY_LIMIT` | no | Mensajes por código por día. Default 60. Es el techo de gasto. |
| `SYNOMA_ALLOWED_ORIGINS` | no | Solo si la app se embebe en otro dominio. Dejalo vacío. |

Después de cargar o cambiar variables: `netlify deploy --prod` para que las tome.

### Netlify Blobs
Habilitalo en el sitio. Lo usan el tope diario de mensajes y el respaldo del perfil. Si no está habilitado, los dos degradan sin romper la app: no hay tope y no hay respaldo, pero todo lo demás funciona.

## Dominio (lo de GHL)
El dominio se maneja desde GHL/DNS: crear el subdominio `synoma.foundersbs.com` como CNAME apuntando al sitio de Netlify (Netlify → Domain settings → Add custom domain te da el destino exacto). GHL no puede hostear la app (no ejecuta backends), pero sí:
- gestiona el DNS del subdominio,
- guarda el código Synoma de cada cliente como custom field del contacto,
- y desde el portal/Skool se linkea `https://synoma.foundersbs.com`.

## Gestión de códigos (proceso del equipo)
- **Alta de cliente** → generar código formato `FND-XXXX` → agregarlo a `SYNOMA_CODES` en Netlify (y al custom field del contacto en GHL) → `netlify deploy --prod`.
- **Baja / fin de programa** → quitarlo de la lista → `netlify deploy --prod`. El acceso muere cuando termina el redeploy (no es instantáneo: hace falta el deploy para que la función tome la lista nueva).
- El perfil del cliente queda en el respaldo del servidor después de la baja. Si hace falta borrarlo, es un borrado manual en el store `synoma-perfiles` de Netlify Blobs.

## Costos
- **Netlify:** gratis en este volumen.
- **API de Claude** (`claude-sonnet-5`, con prompt caching activado): ~0,04 USD por mensaje. Un cliente normal (60 mensajes/mes) sale ~2,50 USD/mes; uno intenso (150 mensajes) ~6 USD.
- ⚠️ Hay **precio introductorio hasta el 31 de agosto de 2026**. En septiembre el costo sube ~50% sin que cambie nada en la app.
- Monitorear en console.anthropic.com → Usage. Los logs de las funciones en Netlify muestran el consumo de tokens por código en cada mensaje.

## Prueba local
```bash
netlify dev     # levanta la app CON funciones en http://localhost:8888
```
Usá un código de la lista de `SYNOMA_CODES`. Sin `netlify dev`, abrir el HTML suelto muestra la interfaz pero el motor no responde.

## Más documentación
- [`docs/EVALUACION.md`](docs/EVALUACION.md) — evaluación técnica: hosting, problemas, costos.
- [`docs/CAMBIOS.md`](docs/CAMBIOS.md) — cada error encontrado con su arreglo.
