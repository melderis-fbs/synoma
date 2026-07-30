# Synoma Founders — Guía de deploy (para el equipo)

## Qué es
App web para clientes: entran con un código único, cargan su identidad (Manual + Oferta + encuesta) una sola vez, y usan el dashboard de comandos para crear su contenido con IA — con la voz y la oferta de cada cliente.

## Arquitectura
- `index.html` — la app completa (login por código → setup de identidad → dashboard). El perfil del cliente se guarda en su navegador (localStorage).
- `netlify/functions/synoma.js` — backend serverless: valida el código, arma el prompt con el perfil del cliente y llama a la API de Claude. **La API key nunca toca el navegador.**
- Si el backend no responde, la app entra en "modo demo" (respuestas de ejemplo) — útil para mostrar la interfaz sin gastar API.

## Deploy en Netlify (15 minutos, una vez)
1. Crear cuenta en netlify.com (o usar la existente de los lead magnets).
2. Instalar CLI: `npm install -g netlify-cli` → `netlify login`.
3. Desde esta carpeta: `netlify init` (crear sitio nuevo, ej. `synoma-founders`) y luego `netlify deploy --prod`.
   - ⚠️ Netlify **Drop** (arrastrar carpeta) NO sirve acá: no soporta funciones. Usar la CLI o conectar un repo Git.
4. En Netlify → Site settings → Environment variables, cargar:
   - `ANTHROPIC_API_KEY` = la key de console.anthropic.com (la compró Vicky).
   - `SYNOMA_CODES` = lista de códigos separados por coma, ej: `FND-ANA1,FND-LUZ2,FND-PAB3`
5. Redeploy (`netlify deploy --prod`) para que tome las variables.

## Dominio (lo de GHL)
El dominio se maneja desde GHL/DNS: crear el subdominio `synoma.foundersbs.com` como CNAME apuntando al sitio de Netlify (Netlify → Domain settings → Add custom domain te da el destino exacto). GHL no puede hostear la app (no ejecuta backends), pero sí:
- gestiona el DNS del subdominio,
- guarda el código Synoma de cada cliente como custom field del contacto,
- y desde el portal/Skool se linkea `https://synoma.foundersbs.com`.

## Gestión de códigos (proceso del equipo)
- Alta de cliente → generar código formato `FND-XXXX` → agregarlo a `SYNOMA_CODES` en Netlify (y al custom field del contacto en GHL) → redeploy.
- Baja / fin de programa → quitarlo de la lista → redeploy. El acceso muere al instante.
- Nota v1: el perfil vive en el navegador del cliente. Si cambia de dispositivo, vuelve a pegar su identidad (2 min). En v2 se puede guardar en una base de datos.

## Costos
- Netlify: gratis en este volumen.
- API de Claude: ~1-3 USD por cliente activo por mes (plan semanal + guiones + revisiones). Monitorear en console.anthropic.com → Usage.

## Prueba local
`netlify dev` desde esta carpeta levanta la app CON función incluida en http://localhost:8888 (usar un código de la lista). Sin `netlify dev`, abrir `index.html` muestra la interfaz en modo demo.
