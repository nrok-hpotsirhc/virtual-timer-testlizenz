// Browser-Test bei 390 px mit dem vorinstallierten Playwright (keine Installation, kein package.json).
// Ablauf je Browser: Schlüssel erzeugen, sperren, falsch und richtig entsperren, License Request File
// von timerd hochladen, Vorschau, signieren, License Response File herunterladen und mit
// licensectl verify prüfen; Ausgabeprotokoll exportieren; Sperre nach Inaktivität und beim
// Verlassen; Schlüssel löschen; Schlüsseldatei aus licensectl keygen importieren und die Lizenz in
// timerd einspielen. Dazu: keine externen Anfragen (gemessen), CSP wirksam, nichts im Web Storage,
// keine Passphrase in IndexedDB, Zielgrößen, kein waagerechter Überlauf (390 und 360 px), Fokus,
// helles und dunkles Schema. Chromium zusätzlich von file://.
//
// Aufruf über tools/gegenprobe.sh oder direkt mit
//   LICENSECTL=… TIMERD=… SCHLUESSELDATEI=… SCHLUESSEL_A=kid:base64 GEGENPROBE_DIR=… node tests/browser.mjs
// Optional BROWSER=chromium oder BROWSER=webkit.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = (k) => {
  if (!process.env[k]) throw new Error(k + ' fehlt (Aufruf über tools/gegenprobe.sh)');
  return process.env[k];
};
const LICENSECTL = env('LICENSECTL');
const TIMERD = env('TIMERD');
const KEYFILE = env('SCHLUESSELDATEI');
const ENTRY_A = env('SCHLUESSEL_A');
const WORK = env('GEGENPROBE_DIR');
const PASS = 'Browser-Test ' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

const results = [];
function check(engine, name, ok, detail) {
  results.push({ engine, name, ok: Boolean(ok), detail: ok ? '' : String(detail || '') });
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
}

// ---------- statischer Server wie GitHub Pages (nur die veröffentlichten Dateien) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const published = (rel) => rel === 'index.html' || rel === 'app.css' || rel === 'manifest.webmanifest' || /^js\/[a-z]+\.js$/.test(rel) || /^icons\/[a-z0-9-]+\.(svg|png)$/.test(rel);
const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  if (req.method !== 'GET' || !published(rel)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(path.join(root, rel)));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = 'http://127.0.0.1:' + server.address().port;

function requestFile(dir) {
  mkdirSync(dir, { recursive: true });
  const r = run(TIMERD, ['license', 'request', '-reference', 'Browser-Test', '-type', 'subscription', '-seats', '3', '-packages', 'trp,mtdoe'],
    { env: { ...process.env, TIMERD_DATA_DIR: dir, TIMERD_HTTP_ADDR: '127.0.0.1:9' } });
  if (r.status !== 0) throw new Error('timerd license request: ' + r.err);
  const file = path.join(dir, 'request.json');
  writeFileSync(file, r.out);
  return file;
}

async function chip(page) {
  return (await page.locator('#zustand').textContent()).trim();
}

async function waitChip(page, text) {
  await page.waitForFunction((t) => document.getElementById('zustand').textContent.trim() === t, text, { timeout: 20000 });
}

// layout prüft Überlauf und Zielgrößen aller sichtbaren Bedienelemente.
async function layout(page) {
  return page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push('Überlauf ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
    const targets = document.querySelectorAll('button, .input, .choice, .segmented label, label.file');
    let n = 0;
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.closest('[hidden]')) continue;
      n++;
      if (r.height < 44 || r.width < 44) problems.push((el.id || el.textContent.trim().slice(0, 30)) + ' ' + Math.round(r.width) + '×' + Math.round(r.height));
      if (el.scrollWidth > el.clientWidth + 1 && el.tagName === 'BUTTON') problems.push('abgeschnitten: ' + el.textContent.trim());
    }
    return { problems, n };
  });
}

async function a11y(page) {
  return page.evaluate(() => {
    const problems = [];
    for (const el of document.querySelectorAll('input')) {
      if (el.closest('[hidden]')) continue;
      const named = el.labels.length > 0 || el.getAttribute('aria-labelledby') || el.getAttribute('aria-label');
      if (!named) problems.push('ohne Beschriftung: ' + (el.id || el.name));
    }
    for (const b of document.querySelectorAll('button')) if (!b.textContent.trim()) problems.push('Taste ohne Text');
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    if (new Set(ids).size !== ids.length) problems.push('IDs doppelt');
    if (document.documentElement.lang !== 'de') problems.push('lang fehlt');
    if (document.querySelectorAll('h1').length !== 1) problems.push('nicht genau eine h1');
    return problems;
  });
}

async function download(page, button, dir) {
  const [d] = await Promise.all([page.waitForEvent('download'), page.locator(button).tap()]);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, d.suggestedFilename());
  await d.saveAs(file);
  return file;
}

async function issue(page, reqFile, engine, dir, label) {
  await page.locator('#anfrage').setInputFiles(reqFile);
  await page.locator('#f-werte').waitFor({ state: 'visible' });
  const pre = await page.evaluate(() => ({
    buyer: [...document.querySelectorAll('input[name="kaeufer"]')].some((r) => r.checked),
    art: document.querySelector('input[name="art"]:checked')?.value,
    monate: document.getElementById('monate').value,
    plaetze: document.getElementById('plaetze').value,
    pakete: [...document.querySelectorAll('input[name="pakete"]:checked')].map((c) => c.value).join(),
  }));
  check(engine, label + ': vorbelegt mit den Wünschen, Käufer ohne Vorauswahl', !pre.buyer && pre.art === 'subscription' && pre.monate === '12' &&
    pre.plaetze === '3' && pre.pakete === 'trp,mtdoe', JSON.stringify(pre));
  await page.locator('#f-werte button[type="submit"]').tap();
  check(engine, label + ': ohne Käufer keine Vorschau', /Käufer wählen/.test(await page.locator('#werte-fehler').textContent()));
  await page.locator('label.choice', { hasText: 'Firma' }).tap();
  await page.locator('#kunde').fill('Hardwaretest');
  await page.locator('#f-werte button[type="submit"]').tap();
  await page.locator('#s-vorschau').waitFor({ state: 'visible' });
  const facts = await page.locator('#vorschau-fakten').textContent();
  check(engine, label + ': Vorschau zeigt die Werte', /Firma Hardwaretest/.test(facts) && /Laufzeitlizenz 12 Monate/.test(facts) && /TRP, Anzeigen-Master/.test(facts), facts);
  await page.locator('#b-signieren').tap();
  await page.locator('#s-fertig').waitFor({ state: 'visible', timeout: 20000 });
  const file = await download(page, '#b-herunterladen', dir);
  check(engine, label + ': Dateiname wie license.ResponseFileName', /^virtualtimer-license-response-[0-9a-f]{8}-[0-9]{8}\.json$/.test(path.basename(file)), path.basename(file));
  return file;
}

async function idbDump(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('vt-testlizenz');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const out = {};
      const names = [...db.objectStoreNames];
      const tx = db.transaction(names, 'readonly');
      for (const n of names) {
        const q = tx.objectStore(n).getAll();
        q.onsuccess = () => {
          out[n] = q.result;
        };
      }
      tx.oncomplete = () => {
        db.close();
        resolve(JSON.stringify(out));
      };
    };
  }));
}

async function flow(engine, browserType, base) {
  const fileMode = base.startsWith('file:');
  const tag = engine + (fileMode ? ' (file://)' : '');
  const dir = path.join(WORK, 'browser-' + engine + (fileMode ? '-datei' : ''));
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // CSP-Verstöße über alle Dokumente des Ablaufs (auch vor dem Neuladen) in Node sammeln
  const csp = [];
  await page.exposeBinding('__cspMelden', (_, v) => csp.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__cspMelden(e.violatedDirective + ' ' + e.blockedURI));
  });
  await page.clock.install();
  try {
    await page.goto(base + '/index.html');
    await waitChip(page, 'Kein Schlüssel');
    check(tag, 'Seite geladen, bereit', true);
    if (!fileMode) {
      const l = await layout(page);
      check(tag, 'Zielgrößen ab 44 px, kein Überlauf bei 390 px (Start, ' + l.n + ' Elemente)', l.problems.length === 0, l.problems.join('; '));
    }

    // Schlüssel erzeugen
    await page.locator('#pp-neu').fill(PASS);
    await page.locator('#pp-neu2').fill(PASS + 'x');
    await page.locator('#b-anlegen').tap();
    check(tag, 'abweichende Wiederholung der Passphrase abgewiesen', /stimmen nicht überein/.test(await page.locator('#f-neu-fehler').textContent()));
    await page.locator('#pp-neu2').fill(PASS);
    let t0 = Date.now();
    await page.locator('#b-anlegen').tap();
    await waitChip(page, 'Entsperrt');
    const entryC = (await page.locator('#oeffentlich').textContent()).trim();
    check(tag, 'Testschlüssel erzeugt (' + (Date.now() - t0) + ' ms), öffentlicher Schlüssel kid:base64', /^test-[0-9]{8}-[0-9]{4}:[A-Za-z0-9+/]{43}=$/.test(entryC), entryC);
    check(tag, 'Passphrase-Felder geleert', (await page.locator('#pp-neu').inputValue()) === '' && (await page.locator('#pp-neu2').inputValue()) === '');

    // sperren, falsch und richtig entsperren
    await page.locator('#b-sperren').tap();
    await waitChip(page, 'Gesperrt');
    await page.locator('#pp').fill('falsche Passphrase!');
    await page.locator('#b-entsperren').tap();
    await page.waitForFunction(() => document.getElementById('f-entsperren-fehler').textContent !== '', null, { timeout: 20000 });
    check(tag, 'falsche Passphrase entsperrt nicht', (await chip(page)) === 'Gesperrt' && /Passphrase falsch/.test(await page.locator('#f-entsperren-fehler').textContent()));
    await page.locator('#pp').fill(PASS);
    t0 = Date.now();
    await page.locator('#b-entsperren').tap();
    await waitChip(page, 'Entsperrt');
    check(tag, 'richtige Passphrase entsperrt (' + (Date.now() - t0) + ' ms, PBKDF2 600 000)', true);

    // ausstellen, herunterladen, licensectl verify
    const reqFile = requestFile(path.join(dir, 'timerd-c'));
    if (!fileMode) {
      await page.locator('#anfrage').setInputFiles(reqFile);
      await page.locator('#f-werte').waitFor({ state: 'visible' });
      const l = await layout(page);
      check(tag, 'Zielgrößen ab 44 px, kein Überlauf bei 390 px (Formular, ' + l.n + ' Elemente)', l.problems.length === 0, l.problems.join('; '));
      await page.setViewportSize({ width: 360, height: 780 });
      const l360 = await layout(page);
      check(tag, 'Zielgrößen ab 44 px, kein Überlauf bei 360 px (Formular)', l360.problems.length === 0, l360.problems.join('; '));
      await page.setViewportSize({ width: 390, height: 844 });
      const a = await a11y(page);
      check(tag, 'Beschriftungen, eindeutige IDs, lang, eine h1', a.length === 0, a.join('; '));
      await page.locator('#b-andere').tap();
    }
    const fileC = await issue(page, reqFile, tag, dir, 'Lizenz mit erzeugtem Schlüssel');
    const ver = run(LICENSECTL, ['verify', '-keys', entryC, fileC]);
    check(tag, 'licensectl verify nimmt die heruntergeladene Lizenz an', ver.status === 0, ver.err);
    if (ver.status === 0) {
      const p = JSON.parse(ver.out);
      check(tag, 'licensectl verify: Kunde, Plätze, Pakete', p.customer === 'Hardwaretest' && p.seats === 3 && p.packages.join() === 'trp,mtdoe', ver.out);
    }

    // Ausgabeprotokoll exportieren
    const ledgerFile = await download(page, '#b-export', dir);
    const lines = readFileSync(ledgerFile, 'utf8').split('\n');
    const entry = JSON.parse(lines[0]);
    check(tag, 'Ausgabeprotokoll als JSONL: eine Zeile, Betriebsart test, Kennung', lines.length === 2 && lines[1] === '' && entry.mode === 'test' &&
      entry.kid === entryC.split(':')[0] && entry.customer === 'Hardwaretest', lines.join('|'));

    // Sperre nach 5 Minuten ohne Bedienung und beim Verlassen der Seite
    await page.clock.fastForward('04:30');
    check(tag, 'nach 4:30 min noch entsperrt', (await chip(page)) === 'Entsperrt');
    await page.clock.fastForward('00:40');
    await waitChip(page, 'Gesperrt');
    check(tag, 'nach 5 min ohne Bedienung gesperrt', true);
    await page.locator('#pp').fill(PASS);
    await page.locator('#b-entsperren').tap();
    await waitChip(page, 'Entsperrt');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await waitChip(page, 'Gesperrt');
    check(tag, 'beim Verlassen der Seite (pagehide) gesperrt', true);
    await page.reload();
    await waitChip(page, 'Gesperrt');
    check(tag, 'nach Neuladen gesperrt, Schlüssel weiter abgelegt', true);

    // Datenschutz im Browser
    const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, url: location.href }));
    check(tag, 'nichts in localStorage und sessionStorage, Adresse ohne Daten', storage.local === 0 && storage.session === 0 && !/[?#]/.test(storage.url), JSON.stringify(storage));
    const dump = await idbDump(page);
    check(tag, 'IndexedDB: verschlüsselter Schlüssel, keine Passphrase, kein PEM', dump.includes('"ciphertext"') && !dump.includes(PASS) && !/PRIVATE KEY|"d":/.test(dump), dump.slice(0, 200));

    // Schlüssel löschen, Schlüsseldatei A importieren, Lizenz in timerd einspielen
    await page.locator('#b-loeschen').tap();
    await page.locator('#b-loeschen-ja').tap();
    await waitChip(page, 'Kein Schlüssel');
    check(tag, 'Schlüssel gelöscht', !(await idbDump(page)).includes('"ciphertext"'));
    await page.locator('.segmented label', { hasText: 'Datei importieren' }).tap();
    await page.locator('#schluesseldatei').setInputFiles(KEYFILE);
    await page.locator('#pp-neu').fill(PASS);
    await page.locator('#pp-neu2').fill(PASS);
    await page.locator('#b-anlegen').tap();
    await waitChip(page, 'Entsperrt');
    check(tag, 'Schlüsseldatei aus licensectl keygen importiert, gleicher öffentlicher Schlüssel', (await page.locator('#oeffentlich').textContent()).trim() === ENTRY_A);
    const dataA = path.join(dir, 'timerd-a');
    const reqA = requestFile(dataA);
    const fileA = await issue(page, reqA, tag, dir, 'Lizenz mit importiertem Schlüssel');
    const imp = run(TIMERD, ['license', 'import', fileA], { env: { ...process.env, TIMERD_DATA_DIR: dataA, TIMERD_HTTP_ADDR: '127.0.0.1:9' } });
    check(tag, 'timerd license import nimmt die Lizenz aus dem Browser an', imp.status === 0 && /Zustand:\s+valid/.test(imp.out) && /Pakete:\s+trp, mtdoe/.test(imp.out), imp.out + imp.err);
    check(tag, 'Ausgabeprotokoll zeigt 2 Einträge', /^2 Einträge/.test(await page.locator('#protokoll-anzahl').textContent()));

    // beschädigter Datensatz: Hinweis statt Blockade, ein neuer Schlüssel ersetzt ihn
    await page.evaluate(() => new Promise((resolve, reject) => {
      const r = indexedDB.open('vt-testlizenz');
      r.onsuccess = () => {
        const tx = r.result.transaction(['schluessel'], 'readwrite');
        tx.objectStore('schluessel').put({ format: 'kaputt' }, 'aktiv');
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload();
    await waitChip(page, 'Kein Schlüssel');
    const broken = await page.locator('#f-neu-fehler').textContent();
    await page.locator('#pp-neu').fill(PASS);
    await page.locator('#pp-neu2').fill(PASS);
    await page.locator('#b-anlegen').tap();
    await waitChip(page, 'Entsperrt');
    check(tag, 'beschädigter Schlüsseldatensatz: Hinweis, durch neuen Schlüssel ersetzbar', /unbekanntes Format/.test(broken), broken);

    // Fokus sichtbar (Tastatur); WebKit fokussiert Tasten per Tab nur mit Systemeinstellung
    if (engine === 'chromium' && !fileMode) {
      await page.keyboard.press('Tab');
      const seen = [];
      for (let i = 0; i < 14; i++) {
        seen.push(await page.evaluate(() => {
          const el = document.activeElement;
          const ring = (e) => {
            const s = getComputedStyle(e);
            return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
          };
          const label = el.closest('label');
          return { id: el.id || el.tagName, ok: ring(el) || (label !== null && ring(label)) };
        }));
        await page.keyboard.press('Tab');
      }
      // BODY: Fokus hat die Seite am Ende der Reihenfolge verlassen (kein Bedienelement)
      const stops = seen.filter((s) => s.id !== 'BODY' && s.id !== 'HTML');
      const bad = stops.filter((s) => !s.ok);
      check(tag, 'Fokusring ab 2 px bei ' + stops.length + ' Fokusstellen', bad.length === 0 && stops.length >= 8, JSON.stringify(seen));
    }

    // CSP-Verstöße der Seite bis hier; die Bildschirmfotos danach fügen in WebKit selbst einen
    // Inline-Stil ein (Playwright, gemessen 2026-11-18) und zählen nicht zur Seite.
    const cspBefore = csp.slice();

    // helles und dunkles Schema
    const bg = {};
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400); // Übergänge der Tasten (150 ms) abwarten, sonst zeigt das Foto Mischfarben
      bg[scheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.screenshot({ path: path.join(dir, 'bildschirm-' + scheme + '.png'), fullPage: true });
    }
    check(tag, 'helles und dunkles Schema', bg.light === 'rgb(238, 241, 245)' && bg.dark === 'rgb(11, 13, 18)', JSON.stringify(bg));

    // CSP wirksam, keine externen Anfragen
    const probe = await page.evaluate(async () => {
      const tryFetch = (u) => fetch(u).then(() => 'erreicht', () => 'blockiert');
      return [await tryFetch('https://example.org/'), await tryFetch('./index.html')];
    });
    await page.waitForTimeout(300); // das Ereignis securitypolicyviolation folgt asynchron
    probe.push(csp.slice(cspBefore.length).join(' | '));
    check(tag, 'CSP blockiert Verbindungen (connect-src none), auch zur eigenen Adresse', probe[0] === 'blockiert' && probe[1] === 'blockiert' && /connect-src/.test(probe[2]), JSON.stringify(probe));
    const own = (u) => (fileMode ? u.startsWith('file://') : u.startsWith(ORIGIN + '/')) || u.startsWith('blob:');
    const foreign = requests.filter((u) => !own(u) && u !== 'https://example.org/');
    const probeReached = requests.filter((u) => u === 'https://example.org/');
    check(tag, 'keine externen Anfragen (' + requests.length + ' Anfragen gemessen, alle lokal)', foreign.length === 0 && probeReached.length === 0, foreign.concat(probeReached).join(', '));
    check(tag, 'keine CSP-Verstöße im Ablauf', cspBefore.length === 0, cspBefore.join(' | '));
    check(tag, 'keine Skriptfehler', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check(tag, 'Ablauf vollständig', false, e.stack || e);
    await page.screenshot({ path: path.join(dir, 'fehler.png'), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

const engines = [['chromium', chromium], ['webkit', webkit]].filter(([n]) => !process.env.BROWSER || process.env.BROWSER === n);
for (const [name, type] of engines) {
  let available = true;
  try {
    const b = await type.launch();
    await b.close();
  } catch (e) {
    available = false;
    results.push({ engine: name, name: 'Browser nicht verfügbar', ok: null, detail: String(e).split('\n')[0] });
  }
  if (!available) continue;
  await flow(name, type, ORIGIN);
  if (name === 'chromium') await flow(name, type, pathToFileURL(root).href);
}
server.close();

let failed = 0;
for (const r of results) {
  const mark = r.ok === null ? 'NOT_RUN' : r.ok ? 'OK     ' : 'FEHLER ';
  if (r.ok === false) failed++;
  console.log(mark + ' ' + r.engine.padEnd(18) + r.name + (r.ok ? '' : '\n         ' + r.detail.split('\n').join('\n         ')));
}
console.log('\nBrowser-Test: ' + results.filter((r) => r.ok).length + ' bestanden, ' + failed + ' fehlgeschlagen, ' + results.filter((r) => r.ok === null).length + ' nicht ausgeführt');
process.exit(failed === 0 ? 0 : 1);
