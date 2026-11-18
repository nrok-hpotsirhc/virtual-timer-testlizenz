// Mutationsproben: Jede Probe baut einen bekannten Fehler in eine Kopie des Codes ein und erwartet,
// dass die Unit-Tests (node --test) ihn finden. Das Repository selbst bleibt unverändert.
//   node tools/mutationsproben.mjs
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const mutations = [
  {
    name: 'Kennung ohne test- angenommen',
    file: 'js/lizenz.js',
    from: "return typeof kid === 'string' && kid.startsWith(TEST_KEY_PREFIX);",
    to: "return typeof kid === 'string';",
  },
  {
    name: 'Signatur über falsche Bytes (base64-Text statt Inhalt)',
    file: 'js/lizenz.js',
    from: 'const sig = await sign(raw);',
    to: 'const sig = await sign(kodierung.utf8(kodierung.base64url(raw)));',
  },
  {
    name: 'Signatur über falsche Bytes (Inhalt ohne HTML-Maskierung)',
    file: 'js/lizenz.js',
    from: 'const sig = await sign(raw);',
    to: 'const sig = await sign(kodierung.utf8(JSON.stringify(JSON.parse(kodierung.fromUtf8(raw)))));',
  },
  {
    name: 'Feld in anderer Schreibweise angenommen',
    file: 'js/gojson.js',
    from: "      if (!names.includes(key)) throw new JsonError('Feld „' + key + '“ unbekannt (Schreibweise beachten)');\n      out.set(key, v);",
    to: "      const known = names.find((n) => n.toLowerCase() === key.toLowerCase());\n      if (!known) throw new JsonError('unbekannt');\n      out.set(known, v);",
  },
  {
    name: 'doppelter Schlüssel angenommen (letzter gilt)',
    file: 'js/gojson.js',
    from: "const allowDuplicates = Boolean(options && options.allowDuplicates);",
    to: 'const allowDuplicates = true;',
  },
  {
    name: 'Passphrase falsch und trotzdem entsperrt (Schlüssel ohne Passphrase abgeleitet)',
    file: 'js/schluessel.js',
    from: "kodierung.utf8(passphrase.normalize('NFC'))",
    to: "kodierung.utf8('')",
  },
  {
    name: 'Passphrase falsch und trotzdem entsperrt (nur die ersten Zeichen zählen)',
    file: 'js/schluessel.js',
    from: "kodierung.utf8(passphrase.normalize('NFC'))",
    to: "kodierung.utf8(passphrase.normalize('NFC').slice(0, 8))",
  },
  {
    name: 'Schlüsseldatei ohne Kennungszeile angenommen (AL-18)',
    file: 'js/schluessel.js',
    from: 'if (kid === null) {',
    to: "if (kid === null && false) {",
  },
];

const results = [];
for (const m of mutations) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mutation-'));
  try {
    cpSync(path.join(root, 'js'), path.join(dir, 'js'), { recursive: true });
    cpSync(path.join(root, 'tests'), path.join(dir, 'tests'), { recursive: true });
    for (const f of ['index.html', 'app.css', 'manifest.webmanifest']) cpSync(path.join(root, f), path.join(dir, f));
    cpSync(path.join(root, 'icons'), path.join(dir, 'icons'), { recursive: true });
    const file = path.join(dir, m.file);
    const src = readFileSync(file, 'utf8');
    if (src.split(m.from).length !== 2) throw new Error('Stelle nicht eindeutig gefunden: ' + m.name);
    writeFileSync(file, src.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8' });
    const failed = /# fail (\d+)/.exec(r.stdout);
    results.push({ name: m.name, caught: r.status !== 0, detail: failed ? failed[1] + ' Tests rot' : 'Exitcode ' + r.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
let missed = 0;
for (const r of results) {
  if (!r.caught) missed++;
  console.log((r.caught ? 'erkannt      ' : 'NICHT ERKANNT') + '  ' + r.name + ' (' + r.detail + ')');
}
console.log('\nMutationsproben: ' + (results.length - missed) + ' von ' + results.length + ' erkannt');
process.exit(missed === 0 ? 0 : 1);
