// Build script — copies static files to dist/ for hosting
import { cpSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = join(__dirname, 'dist');

mkdirSync(dest, { recursive: true });
cpSync(join(__dirname, 'index.html'), join(dest, 'index.html'));
console.log('Build complete: dist/');
