// Statische Prüfungen der Seite: Content-Security-Policy, keine Inline-Skripte oder -Stile, keine
// externen Adressen, keine Netz- oder Speicher-APIs außer IndexedDB, Manifest und Symbole, Kontraste
// der Tokens nach WCAG 2.x (Text 4,5:1, Grenzen und Fokus 3:1) in beiden Farbschemata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const css = read('app.css');
const scripts = readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f);

test('CSP per meta: nur eigene Dateien, keine Verbindungen, keine Inline-Skripte', () => {
  const metas = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g) || [];
  assert.equal(metas.length, 1);
  const policy = /content="([^"]+)"/.exec(metas[0])[1];
  const dir = new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.equal(dir.get('default-src'), "'self'");
  assert.equal(dir.get('script-src'), "'self'");
  assert.equal(dir.get('style-src'), "'self'");
  assert.equal(dir.get('connect-src'), "'none'");
  assert.equal(dir.get('object-src'), "'none'");
  assert.equal(dir.get('base-uri'), "'none'");
  assert.equal(dir.get('form-action'), "'none'");
  assert.equal(dir.get('worker-src'), "'none'");
  assert.equal(dir.get('require-trusted-types-for'), "'script'");
  assert.doesNotMatch(policy, /unsafe-|https?:|data:|blob:|\*/);
  // CSP steht vor dem ersten Skript und Stil
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link rel="stylesheet"'));
});

test('HTML: keine Inline-Skripte, -Stile oder Ereignis-Attribute; alle Verweise lokal und vorhanden', () => {
  for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g)) {
    assert.match(tag, /^<script src="js\/[a-z]+\.js" defer><\/script>$/, tag);
  }
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|javascript:/i);
  const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8);
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^[a-z]+:|^\/\//i, ref);
    assert.ok(existsSync(path.join(root, ref)), ref);
  }
  for (const s of scripts) assert.ok(html.includes('src="' + s + '"'), s + ' eingebunden');
});

test('Skripte und Stile: keine Netz-APIs, keine externen Adressen, keine Protokollausgaben', () => {
  for (const f of [...scripts, 'app.css', 'manifest.webmanifest']) {
    const src = read(f);
    assert.doesNotMatch(src, /https?:\/\//, f);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|serviceWorker/, f);
    assert.doesNotMatch(src, /\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /localStorage|sessionStorage|document\.cookie|location\.(?:hash|search)\s*=/, f);
    assert.doesNotMatch(src, /\bconsole\./, f);
  }
  assert.doesNotMatch(css, /@import|url\(/);
});

function pngSize(file) {
  const b = readFileSync(path.join(root, file));
  assert.equal(b.subarray(1, 4).toString(), 'PNG', file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('Manifest und Symbole (installierbar als Web-App)', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.equal(m.lang, 'de');
  for (const icon of m.icons) {
    assert.ok(existsSync(path.join(root, icon.src)), icon.src);
    if (icon.type === 'image/png') assert.deepEqual(pngSize(icon.src), icon.sizes.split('x').map(Number));
  }
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), [180, 180]);
});

// ---------- Kontraste ----------

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: light)')));
const light = { ...dark, ...tokens(css.slice(css.indexOf('@media (prefers-color-scheme: light)'), css.indexOf('*, *::before'))) };

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
function lum(c) {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

for (const [name, t] of [['dunkel', dark], ['hell', light]]) {
  test('Kontraste nach WCAG AA, Schema ' + name, () => {
    const c = (k) => rgb(t[k]);
    const tint = parseFloat(t.tint) / 100;
    const tinted = (tone, base) => mix(c(tone), c(base), tint);
    const text = [
      ['text', c('text'), c('bg')], ['text/surface', c('text'), c('surface')], ['text/surface-2', c('text'), c('surface-2')],
      ['text/surface-3', c('text'), c('surface-3')], ['muted/bg', c('text-muted'), c('bg')], ['muted/surface', c('text-muted'), c('surface')],
      ['muted/surface-2', c('text-muted'), c('surface-2')], ['Hauptaktion', c('accent-text'), c('accent')],
      ['Fehlertext', c('danger'), c('surface')], ['Warnhinweis', c('warn'), c('surface')], ['Löschen', c('bg'), c('danger')],
      ['Chip ok', c('ok'), tinted('ok', 'surface')], ['Chip warn', c('warn'), tinted('warn', 'surface')], ['Chip danger', c('danger'), tinted('danger', 'surface')],
      ['Chip neutral', c('text-muted'), tinted('text-muted', 'surface')], ['Meldung ok', c('text'), tinted('ok', 'surface')],
      ['Meldung danger', c('text'), tinted('danger', 'surface')], ['gewählt', c('text'), tinted('accent', 'surface')],
    ];
    for (const [label, fg, bg] of text) assert.ok(ratio(fg, bg) >= 4.5, label + ' ' + ratio(fg, bg).toFixed(2));
    const ui = [
      ['Rand/bg', c('border-strong'), c('bg')], ['Rand/surface', c('border-strong'), c('surface')],
      ['Fokus/bg', c('focus'), c('bg')], ['Fokus/surface', c('focus'), c('surface')], ['Fokus/surface-2', c('focus'), c('surface-2')],
      ['Akzent/surface', c('accent'), c('surface')],
    ];
    for (const [label, fg, bg] of ui) assert.ok(ratio(fg, bg) >= 3, label + ' ' + ratio(fg, bg).toFixed(2));
  });
}
