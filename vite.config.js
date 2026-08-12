import { defineConfig, loadEnv } from 'vite';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  if (mode === 'development' || mode === 'serve') {
    const env = loadEnv(mode, __dirname, '');
    for (const [k, v] of Object.entries(env)) {
      if (!(k in process.env)) process.env[k] = v;
    }
  }

  return {
    server: {
      port: 5173,
      proxy: {
        '/functions': {
          target: 'https://lzdzgquzucgznrmeldix.supabase.co',
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: { outDir: 'dist' },
  };
});
