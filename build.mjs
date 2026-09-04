// Build script — copies static files to dist/ for hosting
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = join(__dirname, 'dist');

mkdirSync(dest, { recursive: true });
cpSync(join(__dirname, 'index.html'), join(dest, 'index.html'));
cpSync(join(__dirname, 'analizador.html'), join(dest, 'analizador.html'));

// Copy everything in public/ (images, etc.) into dist/
const publicDir = join(__dirname, 'public');
if (existsSync(publicDir)) {
  cpSync(publicDir, dest, { recursive: true });
}

console.log('Build complete: dist/');
