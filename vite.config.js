import { defineConfig } from 'vite';
import { pathToFileURL } from 'url';
import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFunctions() {
  const dir = join(__dirname, 'netlify', 'functions');
  const files = (await readdir(dir)).filter(f => !f.startsWith('_') && f.endsWith('.js'));

  const routes = [];
  for (const file of files) {
    const path = join(dir, file);
    const mod = await import(pathToFileURL(path).href);
    if (mod.default && mod.config?.path) {
      routes.push({ path: mod.config.path, handler: mod.default, name: file });
    }
  }
  return routes;
}

export default defineConfig(async ({ mode }) => {
  const routes = mode === 'serve' ? await loadFunctions() : [];

  return {
    server: {
      port: 5173,
      middleware: [
        async (req, res, next) => {
          if (!req.url.startsWith('/api/')) return next();

          try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const route = routes.find(r => r.path === url.pathname);
            if (!route) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'not_found' }));
              return;
            }

            // Build a Request object from the IncomingMessage
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (Array.isArray(v)) headers.set(k, v.join(','));
              else if (v) headers.set(k, v);
            }

            const body = req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD'
              ? new ReadableStream({
                  start(controller) {
                    req.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
                    req.on('end', () => controller.close());
                    req.on('error', (e) => controller.error(e));
                  },
                })
              : null;

            const request = new Request(url.href, {
              method: req.method,
              headers,
              body,
              duplex: 'half',
            });

            const response = await route.handler(request);

            // Handle streaming responses
            if (response.body instanceof ReadableStream) {
              res.statusCode = response.status;
              response.headers.forEach((v, k) => res.setHeader(k, v));
              const reader = response.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
            } else {
              res.statusCode = response.status;
              response.headers.forEach((v, k) => res.setHeader(k, v));
              const buf = await response.arrayBuffer();
              res.end(Buffer.from(buf));
            }
          } catch (e) {
            console.error(`[api] ${req.url}:`, e?.message ?? e);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'internal', message: e?.message ?? String(e) }));
          }
        },
      ],
    },
    build: {
      outDir: 'dist',
    },
  };
});
