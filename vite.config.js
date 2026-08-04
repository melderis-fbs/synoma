import { defineConfig, loadEnv } from 'vite';
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cache of loaded route handlers: { path: handler }
let _routes = null;

async function loadFunctions() {
  if (_routes) return _routes;
  _routes = {};
  try {
    const { readdir } = await import('fs/promises');
    const dir = join(__dirname, 'netlify', 'functions');
    const files = (await readdir(dir)).filter(f => !f.startsWith('_') && f.endsWith('.js'));
    for (const file of files) {
      try {
        const mod = await import(pathToFileURL(join(dir, file)).href);
        if (mod.default && mod.config?.path) {
          _routes[mod.config.path] = mod.default;
        }
      } catch (e) {
        console.error(`[api] No se pudo cargar ${file}:`, e?.message ?? e);
      }
    }
    console.log(`[api] ${Object.keys(_routes).length} rutas cargadas:`, Object.keys(_routes));
  } catch (e) {
    console.error('[api] No se pudieron cargar las funciones:', e?.message ?? e);
  }
  return _routes;
}

function apiPlugin() {
  return {
    name: 'synoma-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();

        try {
          const routes = await loadFunctions();
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const handler = routes[url.pathname];

          if (!handler) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'not_found', path: url.pathname }));
            return;
          }

          // Build a Web API Request from the Node.js IncomingMessage
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (Array.isArray(v)) headers.set(k, v.join(','));
            else if (v != null) headers.set(k, String(v));
          }

          let body = null;
          if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            body = Buffer.concat(chunks);
          }

          const request = new Request(url.href, {
            method: req.method,
            headers,
            body: body || undefined,
            duplex: 'half',
          });

          const response = await handler(request);

          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));

          if (response.body instanceof ReadableStream) {
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
            res.end();
          } else {
            const buf = await response.arrayBuffer();
            res.end(Buffer.from(buf));
          }
        } catch (e) {
          console.error(`[api] ${req.url}:`, e?.stack ?? e?.message ?? e);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
          }
          res.end(JSON.stringify({ error: 'internal', message: e?.message ?? String(e) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load ALL env vars (not just VITE_*) so server functions see DATABASE_URL, etc.
  if (mode === 'development' || mode === 'serve') {
    const env = loadEnv(mode, __dirname, '');
    for (const [k, v] of Object.entries(env)) {
      if (!(k in process.env)) process.env[k] = v;
    }
  }

  return {
    plugins: [apiPlugin()],
    server: {
      port: 5173,
    },
    build: {
      outDir: 'dist',
    },
  };
});
