// Erzeugt die PNG-Symbole aus icons/symbol.svg mit dem vorinstallierten Playwright (Chromium).
// Einmalig bzw. nach einer Änderung am Symbol: node tools/symbole.mjs
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'icons/symbol.svg'), 'utf8');

// Das Symbol für iOS ohne eigene Rundung: iOS rundet selbst und füllt Transparenz schwarz.
const targets = [
  ['icons/symbol-192.png', 192, svg],
  ['icons/symbol-512.png', 512, svg],
  ['icons/apple-touch-icon.png', 180, svg.replace('rx="112"', 'rx="0"')],
];
const browser = await chromium.launch();
try {
  for (const [file, size, source] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const url = 'data:image/svg+xml;base64,' + Buffer.from(source).toString('base64');
    await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block}</style><img width="' + size + '" height="' + size + '" src="' + url + '">');
    await page.locator('img').screenshot({ path: path.join(root, file), omitBackground: true });
    await page.close();
    console.log(file, size);
  }
} finally {
  await browser.close();
}
