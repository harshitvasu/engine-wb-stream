import fs from 'fs';
import path from 'path';

/**
 * Copies Excalidraw static font and locale assets from node_modules into public/
 * so they can be served statically by Vite without being checked into git.
 */
const rootDir = process.cwd();
const srcFonts = path.join(rootDir, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const srcLocales = path.join(rootDir, 'node_modules/@excalidraw/excalidraw/dist/prod/locales');
const destFonts = path.join(rootDir, 'public/fonts');
const destLocales = path.join(rootDir, 'public/locales');

if (fs.existsSync(srcFonts)) {
  fs.mkdirSync(destFonts, { recursive: true });
  fs.cpSync(srcFonts, destFonts, { recursive: true });
}

if (fs.existsSync(srcLocales)) {
  fs.mkdirSync(destLocales, { recursive: true });
  fs.cpSync(srcLocales, destLocales, { recursive: true });
}
