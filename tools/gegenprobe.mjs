// Gegenprobe mit dem echten Produkt; Aufruf über tools/gegenprobe.sh (baut licensectl, erzeugt
// Schlüssel A mit licensectl keygen). Prüft mit demselben Code, den die Seite im Browser nutzt:
//   a  Schlüsseldatei A importieren (verschlüsselt ablegen, entsperren), Lizenz signieren,
//      licensectl verify;
//   b  Schlüssel B im Werkzeug erzeugen, timerd mit A und B bauen (trustedKeysFlag), Lizenz aus dem
//      License Request File von timerd ausstellen und mit timerd license import einspielen;
//   c  Bytegleichheit mit licensectl sign: gleiche Werte, Lizenz-ID und Zeitpunkt aus der Datei von
//      licensectl, Schlüssel A → identische Datei (Ed25519 ist deterministisch) und gleiche Zeile im
//      Ausgabeprotokoll (ohne issuedBy, licensectlVersion);
//   d  Gegenüberstellung der Prüfung des License Request File mit licensectl sign an Grenzfällen;
//   e  Testvektoren des Produkts nachrechnen (Inhalt neu kodiert, Signatur aus dem Seed);
//   f  Ausgabeprotokoll des Werkzeugs in licensectl: Kontingent wird gezählt.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kodierung = require(path.join(root, 'js/kodierung.js'));
const gojson = require(path.join(root, 'js/gojson.js'));
const lizenz = require(path.join(root, 'js/lizenz.js'));
const schluessel = require(path.join(root, 'js/schluessel.js'));
const { subtle } = globalThis.crypto;

const [work, toolchain, entryA] = process.argv.slice(2);
if (!work || !toolchain || !entryA) throw new Error('Aufruf über tools/gegenprobe.sh');
const bin = (n) => path.join(work, 'bin', n);
const out = (n) => path.join(work, 'out', n);
mkdirSync(path.join(work, 'out'), { recursive: true });

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: Boolean(ok), detail: ok ? '' : String(detail || '') });
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '') + (r.error ? String(r.error) : '') };
}
const timerdEnv = (dir) => ({ ...process.env, TIMERD_DATA_DIR: dir, TIMERD_HTTP_ADDR: '127.0.0.1:9', TIMERD_AUDIT: 'on' });
const randomHex = (n) => kodierung.hex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
// Passphrase nur im Speicher dieses Laufs
const PASS = 'gegenprobe ' + randomHex(16);

async function toolKey(material) {
  const record = await schluessel.seal(material, PASS, new Date());
  return schluessel.unlock(record, PASS);
}

function form(over) {
  return lizenz.checkForm({ buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '12', updates: '12', seats: '1', packages: [], contingent: '', ...over });
}

// signGo ruft licensectl sign mit denselben Werten wie das Formular auf.
function signGo(v, requestFile, outFile, ledger) {
  const args = ['sign', '-key', path.join(work, 'keys/test-gegenprobe-a.key'), '-kid', 'test-gegenprobe-a', '-request', requestFile,
    '-ledger', ledger, '-betriebsart', 'test', '-out', outFile];
  args.push(v.buyer === 'privat' ? '-kundennummer' : '-customer', v.customer);
  args.push('-type', v.type, '-seats', v.seats);
  if (v.type === 'subscription') args.push('-months', v.months);
  else args.push('-update-months', v.updates);
  if (v.packages && v.packages.length) args.push('-packages', v.packages.join(','));
  if (v.contingent) args.push('-contingent', v.contingent);
  return run(bin('licensectl'), args);
}

// fromGo liest Lizenz-ID und Ausstellung aus einer Datei von licensectl.
function fromGo(bytes) {
  const env = JSON.parse(kodierung.fromUtf8(bytes));
  const p = JSON.parse(kodierung.fromUtf8(kodierung.fromBase64url(env.payload)));
  return { idBytes: kodierung.fromHex(p.licenseId.slice(2)), now: new Date(p.issued) };
}

function stripGoOnly(line) {
  return line.replace(/,"issuedBy":"(?:[^"\\]|\\.)*"/, '').replace(/,"licensectlVersion":"(?:[^"\\]|\\.)*"/, '');
}

function lastLine(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  return lines[lines.length - 1];
}

// ---------- Schlüssel ----------
const keyFileText = readFileSync(path.join(work, 'keys/test-gegenprobe-a.key'), 'utf8');
const matA = await schluessel.fromKeyFile(keyFileText);
check('a', 'Schlüsseldatei aus keygen importiert, öffentlicher Schlüssel wie keygen', schluessel.formatKey(matA.kid, matA.publicRaw) === entryA,
  schluessel.formatKey(matA.kid, matA.publicRaw) + ' ≠ ' + entryA);
const keyA = await toolKey(matA);
check('a', 'entsperrter Schlüssel nicht exportierbar', keyA.privateKey.extractable === false);
const matB = await schluessel.generate(new Date());
const entryB = schluessel.formatKey(matB.kid, matB.publicRaw);
const keyB = await toolKey(matB);
console.log('Schlüssel A (keygen): ' + entryA);
console.log('Schlüssel B (Werkzeug): ' + entryB);

// ---------- timerd mit A und B bauen ----------
console.log('Baue timerd (Testbuild, Version 0.1.0-dev) mit beiden Testschlüsseln');
const build = run('go', ['build', '-trimpath', '-ldflags', '-X virtualtimer/internal/license.trustedKeysFlag=' + entryA + ',' + entryB, '-o', bin('timerd'), './cmd/timerd'],
  { cwd: path.join(work, 'src'), env: { ...process.env, GOTOOLCHAIN: toolchain, CGO_ENABLED: '0' } });
if (build.status !== 0) throw new Error('timerd-Build: ' + build.err);

const dataDir = path.join(work, 'timerd-daten');
mkdirSync(dataDir, { recursive: true });
const reqRun = run(bin('timerd'), ['license', 'request', '-reference', 'Gegenprobe', '-type', 'subscription', '-seats', '3', '-packages', 'trp,mtdoe'], { env: timerdEnv(dataDir) });
check('b', 'timerd license request', reqRun.status === 0, reqRun.err);
const reqFile = out('request.json');
writeFileSync(reqFile, reqRun.out);
const req = lizenz.parseRequest(kodierung.utf8(reqRun.out));
check('b', 'License Request File von timerd gelesen, Wünsche übernommen', lizenz.wishesText(req.wishes) === 'Laufzeitlizenz 12 Monate, 3 Bedienplätze, Pakete TRP, Anzeigen-Master', lizenz.wishesText(req.wishes));

// ---------- a: Import, signieren, licensectl verify ----------
const v1 = { ...lizenz.prefill(req), buyer: 'firma', customer: 'Hardwaretest' };
const issuedA = await lizenz.issue(keyA, req, lizenz.checkForm(v1), { now: new Date(), idBytes: globalThis.crypto.getRandomValues(new Uint8Array(8)), subtle });
writeFileSync(out(issuedA.fileName), issuedA.bytes);
const ver = run(bin('licensectl'), ['verify', '-keys', entryA, out(issuedA.fileName)]);
check('a', 'licensectl verify nimmt die Lizenz an', ver.status === 0, ver.err);
if (ver.status === 0) {
  const p = JSON.parse(ver.out);
  check('a', 'licensectl verify liest dieselben Werte', p.licenseId === issuedA.payload.licenseId && p.customer === 'Hardwaretest' && p.seats === 3 &&
    p.packages.join() === 'trp,mtdoe' && p.installationId === req.installationId && p.type === 'subscription', ver.out);
}
const verWrong = run(bin('licensectl'), ['verify', '-keys', entryB.replace(matB.kid, 'test-gegenprobe-a'), out(issuedA.fileName)]);
check('a', 'licensectl verify weist sie mit falschem Schlüssel ab', verWrong.status !== 0 && /Signatur/.test(verWrong.err), verWrong.err);

// ---------- b: Schlüssel aus dem Werkzeug, Einspielen in timerd ----------
const issuedB = await lizenz.issue(keyB, req, lizenz.checkForm(v1), { now: new Date(), idBytes: globalThis.crypto.getRandomValues(new Uint8Array(8)), subtle });
const fileB = out('b-' + issuedB.fileName);
writeFileSync(fileB, issuedB.bytes);
const imp = run(bin('timerd'), ['license', 'import', fileB], { env: timerdEnv(dataDir) });
check('b', 'timerd license import nimmt die Lizenz an (Schlüssel aus dem Werkzeug)', imp.status === 0 && /Zustand:\s+valid/.test(imp.out), imp.out + imp.err);
check('b', 'timerd zeigt Lizenz, Plätze und Pakete', imp.out.includes(issuedB.payload.licenseId) && /Bedienplaetze:\s+3/.test(imp.out) && /Pakete:\s+trp, mtdoe/.test(imp.out), imp.out);
const impA = run(bin('timerd'), ['license', 'import', out(issuedA.fileName)], { env: timerdEnv(dataDir) });
check('b', 'timerd license import nimmt auch die Lizenz mit Schlüssel A an', impA.status === 0 && /Zustand:\s+valid/.test(impA.out), impA.out + impA.err);
const env = JSON.parse(issuedB.text);
const tampered = { ...env, payload: env.payload.slice(0, 20) + (env.payload[20] === 'A' ? 'B' : 'A') + env.payload.slice(21) };
writeFileSync(out('veraendert.json'), JSON.stringify(tampered, null, 2));
const impBad = run(bin('timerd'), ['license', 'import', out('veraendert.json')], { env: timerdEnv(dataDir) });
check('b', 'timerd weist eine veränderte Lizenz ab', impBad.status !== 0, impBad.out);
const status = run(bin('timerd'), ['license', 'status'], { env: timerdEnv(dataDir) });
check('b', 'timerd license status: weiterhin gültig mit Lizenz A', /Zustand:\s+valid/.test(status.out) && status.out.includes(issuedA.payload.licenseId), status.out);

// ---------- c: Bytegleichheit mit licensectl sign ----------
const crafted = (tail, id) => '{"format":"timerd-license-request/1","installationId":"' + (id || randomHex(16)) + '"' + tail;
const reqSpecial = crafted(',"features":{"z":"1","Z":"2","é":"<&>","\\ue000":"\\u2028","\\ud83d\\ude00":"\\"\\\\","\\ud800":"x","a":null,"10":"9","9":"10"},' +
  '"version":"9.9.9","created":"2026-11-18T10:00:00\\u005a","reference":"<Ref & \\u2029>","wishes":{"type":"event","seats":9999,"packages":["mtdoe","trp"]}}');
const variants = [
  ['Firma, Laufzeitlizenz, Pakete aus den Wünschen (Request von timerd)', reqFile, v1],
  ['Privatperson, Dauerlizenz ohne Updates-Ende, ohne Pakete', reqFile, { buyer: 'privat', customer: 'K-100234', type: 'perpetual', months: '12', updates: '0', seats: '1', packages: [], contingent: '' }],
  ['Sonderzeichen im Kunden, Dauerlizenz 24 Monate Updates, Kontingent', reqFile, { buyer: 'firma', customer: '  Bühne & Licht <Test> "Ä" \u2028 😀 \u202e \u0085', type: 'perpetual', months: '12', updates: '24', seats: '2', packages: ['mtdoe'], contingent: 'GP-1:5' }],
  ['Merkmale mit Escapes und Sortierfallen, Event-Lizenz, 9999 Plätze', reqSpecial, { buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '1', updates: '12', seats: '9999', packages: ['trp'], contingent: '' }],
  ['ohne Merkmale und Wünsche, 120 Monate, beide Pakete, Kontingent', crafted('}'), { buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '120', updates: '12', seats: '1', packages: ['trp', 'mtdoe'], contingent: 'GP-1:5' }],
  ['leeres Merkmalsobjekt, Monatsende', crafted(',"features":{}}'), { buyer: 'privat', customer: 'K-1', type: 'subscription', months: '1', updates: '12', seats: '7', packages: [], contingent: '' }],
];
const ledgerGo = out('ausgabeprotokoll-licensectl.jsonl');
for (const [i, [name, request, values]] of variants.entries()) {
  let file = request;
  if (!request.startsWith('/')) {
    file = out('c-request-' + i + '.json');
    writeFileSync(file, request);
  }
  const goFile = out('c-go-' + i + '.json');
  const g = signGo(values, file, goFile, ledgerGo);
  if (g.status !== 0) {
    check('c', name, false, 'licensectl sign: ' + g.err);
    continue;
  }
  const goBytes = new Uint8Array(readFileSync(goFile));
  const fixed = fromGo(goBytes);
  const r = lizenz.parseRequest(new Uint8Array(readFileSync(file)));
  const mine = await lizenz.issue(keyA, r, lizenz.checkForm(values), { ...fixed, subtle });
  check('c', name + ': License Response File Byte für Byte gleich', kodierung.equal(mine.bytes, goBytes),
    '\nGo:   ' + kodierung.fromUtf8(goBytes) + '\nhier: ' + mine.text);
  const goLine = stripGoOnly(lastLine(ledgerGo));
  check('c', name + ': Zeile im Ausgabeprotokoll gleich (ohne issuedBy, licensectlVersion)', goLine === mine.ledgerLine, '\nGo:   ' + goLine + '\nhier: ' + mine.ledgerLine);
  check('c', name + ': Dateiname wie license.ResponseFileName', mine.fileName === 'virtualtimer-license-response-' + r.installationId.slice(0, 8) + '-' +
    fixed.now.toISOString().slice(0, 10).replace(/-/g, '') + '.json', mine.fileName);
}

// ---------- d: Prüfung des License Request File gegen licensectl sign ----------
const ID = randomHex(16);
const base = '{"format":"timerd-license-request/1","installationId":"' + ID + '"';
const corpus = [
  '}', '}  ', '\n}\n', ',"created":"2026-11-18T10:00:00Z"}', ',"created":"2026-11-18T10:00:00+00:00"}', ',"created":"2026-11-18T10:00:00-00:00"}',
  ',"created":"2026-11-18T10:00:00+01:00"}', ',"created":"2026-11-18T10:00:00\\u005a"}', ',"created":"2026-11-18T1:00:00Z"}',
  ',"created":"2026-11-18T10:00:00,5Z"}', ',"created":"2026-11-18T10:00:00.123456789123Z"}', ',"created":"2026-02-29T10:00:00Z"}',
  ',"created":"2028-02-29T10:00:00Z"}', ',"created":"2026-11-18t10:00:00z"}', ',"created":"2026-11-18T24:00:00Z"}', ',"created":"2026-11-18T23:59:60Z"}',
  ',"created":"2026-11-18T10:00:00.Z"}', ',"created":"2026-11-18 10:00:00Z"}', ',"created":""}', ',"created":null}', ',"created":1}',
  ',"features":null}', ',"features":{}}', ',"features":{"a":null}}', ',"features":{"a":1}}', ',"features":{"a":"b","a":"c"}}', ',"features":[]}',
  ',"features":{"\\ud800":"x","\\udc00\\ud800\\udc00":"y","\\ud800\\u0041":"z"}}',
  ',"wishes":null}', ',"wishes":{}}', ',"wishes":{"seats":-0}}', ',"wishes":{"seats":-1}}', ',"wishes":{"seats":10000}}', ',"wishes":{"seats":1.0}}',
  ',"wishes":{"seats":1e0}}', ',"wishes":{"seats":01}}', ',"wishes":{"seats":99999999999999999999}}', ',"wishes":{"packages":[null]}}',
  ',"wishes":{"packages":["trp","trp"]}}', ',"wishes":{"packages":["mtdoe","trp"]}}', ',"wishes":{"type":"Event"}}', ',"wishes":{"Type":"event"}}',
  ',"wishes":{"packages":null,"type":null,"seats":null}}', ',"FORMAT":"x"}', ',"Format":"timerd-license-request/1"}', ',"INSTALLATIONID":"x"}',
  ',"version":1}', ',"version":null}', ',"extra":true}', '} x', ',"reference":"tab\ttab"}', ',"reference":"a\\u0000b"}',
  ',"reference":"' + '€'.repeat(80) + '"}', ',"reference":"' + '€'.repeat(81) + '"}', ',"reference":"😀' + 'x'.repeat(79) + '"}',
].map((t) => ({ name: t.length > 60 ? t.slice(0, 57) + '…' : t, bytes: kodierung.utf8(base + t) }));
corpus.push({ name: 'BOM vorne', bytes: kodierung.utf8('\ufeff' + base + '}') });
corpus.push({ name: 'null', bytes: kodierung.utf8('null') });
corpus.push({ name: 'Lizenz statt Anfrage', bytes: issuedA.bytes });
corpus.push({ name: 'Format /2', bytes: kodierung.utf8(base.replace('/1"', '/2"') + '}') });
corpus.push({ name: 'größer als 16 KiB', bytes: kodierung.utf8(base + ',"version":"' + 'x'.repeat(16 << 10) + '"}') });
const invalidUtf8 = kodierung.utf8(base + ',"reference":"X"}');
invalidUtf8[invalidUtf8.length - 3] = 0xff;
corpus.push({ name: 'ungültiges UTF-8 im Text (bewusst strenger)', bytes: invalidUtf8, stricter: true });

const ledgerD = out('ausgabeprotokoll-korpus.jsonl');
let agree = 0;
let deviations = 0;
for (const [i, c] of corpus.entries()) {
  const file = out('d-' + i + '.json');
  writeFileSync(file, c.bytes);
  const goFile = out('d-go-' + i + '.json');
  const g = signGo({ buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '12', seats: '1', packages: [], contingent: '' }, file, goFile, ledgerD);
  let mine = null;
  let err = null;
  try {
    mine = lizenz.parseRequest(c.bytes);
  } catch (e) {
    err = e;
  }
  const goOk = g.status === 0;
  if (c.stricter) {
    check('d', c.name + ': Go nimmt an, Werkzeug weist ab', goOk && err !== null, 'Go ' + goOk + ', Werkzeug ' + (err ? err.message : 'angenommen'));
    deviations++;
    continue;
  }
  if (goOk !== (err === null)) {
    check('d', c.name, false, 'Go ' + (goOk ? 'nimmt an' : 'weist ab: ' + g.err.trim()) + '; Werkzeug ' + (err ? 'weist ab: ' + err.message : 'nimmt an'));
    continue;
  }
  if (goOk) {
    const goBytes = new Uint8Array(readFileSync(goFile));
    const r = await lizenz.issue(keyA, mine, form({}), { ...fromGo(goBytes), subtle });
    if (!kodierung.equal(r.bytes, goBytes)) {
      check('d', c.name + ': Lizenz Byte für Byte gleich', false, '\nGo:   ' + kodierung.fromUtf8(goBytes) + '\nhier: ' + r.text);
      continue;
    }
  } else if (/License Response File/.test(g.err) !== (err.code === 'is_response')) {
    check('d', c.name + ': gleiche Art der Abweisung', false, g.err + ' / ' + err.message);
    continue;
  }
  agree++;
}
check('d', agree + ' von ' + (corpus.length - deviations) + ' Grenzfällen gleich entschieden (angenommene Byte für Byte gleich), ' + deviations + ' bewusst strenger',
  agree === corpus.length - deviations, 'siehe Einzelbefunde');

// ---------- e: Testvektoren des Produkts ----------
const tv = path.join(work, 'src/docs/formate/testvektoren');
const index = JSON.parse(readFileSync(path.join(tv, 'index.json'), 'utf8'));
const lk = index.keys.lizenz;
const seed = new Uint8Array(await subtle.digest('SHA-256', kodierung.utf8(lk.seedText)));
const der = new Uint8Array(48);
der.set(kodierung.fromHex('302e020100300506032b657004220420'));
der.set(seed, 16);
const vecPriv = await subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
const vecPub = kodierung.fromBase64(lk.public);
let vectors = 0;
for (const entry of index.results) {
  const result = JSON.parse(readFileSync(path.join(tv, entry.file), 'utf8'));
  for (const r of result.results || []) {
    if (!r.response || r.response.kid !== lk.kid) continue;
    let v;
    try {
      v = await lizenz.verifyLicense(kodierung.utf8(JSON.stringify(r.response)), new Map([[lk.kid, vecPub]]), subtle);
    } catch (e) {
      continue; // absichtlich ungültige Vektoren (z. B. falscher Inhalt) prüft d bzw. die Unit-Tests
    }
    const payloadBytes = kodierung.fromBase64url(r.response.payload);
    const again = kodierung.utf8(gojson.marshal(v.payload));
    const sig = kodierung.base64url(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, vecPriv, payloadBytes)));
    check('e', entry.file + ' ' + r.orderId + ': Inhalt neu kodiert gleich, Signatur aus dem Seed gleich', kodierung.equal(again, payloadBytes) && sig === r.response.sig,
      kodierung.fromUtf8(again) + ' / ' + kodierung.fromUtf8(payloadBytes));
    vectors++;
  }
}
check('e', vectors + ' gültige Lizenzen aus den Testvektoren nachgerechnet', vectors >= 2, 'zu wenige Vektoren gefunden');

// ---------- f: Ausgabeprotokoll des Werkzeugs in licensectl ----------
const ids = [randomHex(16), randomHex(16), randomHex(16)];
const lines = [];
for (const id of ids.slice(0, 2)) {
  const r = await lizenz.issue(keyA, lizenz.parseRequest(kodierung.utf8(crafted('}', id))), form({ contingent: 'GP-2:2' }),
    { now: new Date(), idBytes: globalThis.crypto.getRandomValues(new Uint8Array(8)), subtle });
  lizenz.checkContingent(lizenz.readLedger(lines), { id: 'GP-2', total: 2 }, id);
  lines.push(r.ledgerLine);
}
const ledgerTool = out('ausgabeprotokoll-werkzeug.jsonl');
writeFileSync(ledgerTool, lines.map((l) => l + '\n').join(''));
const third = out('f-request-3.json');
writeFileSync(third, crafted('}', ids[2]));
const full = signGo({ buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '12', seats: '1', packages: [], contingent: 'GP-2:2' }, third, out('f-3.json'), ledgerTool);
check('f', 'licensectl liest das Protokoll des Werkzeugs: Kontingent GP-2 mit 2 von 2 erschöpft', full.status !== 0 && /Kontingent GP-2 erschoepft \(2 von 2/.test(full.err), full.err);
const renew = out('f-request-1.json');
writeFileSync(renew, crafted('}', ids[0]));
const again = signGo({ buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '12', seats: '1', packages: [], contingent: 'GP-2:2' }, renew, out('f-1.json'), ledgerTool);
check('f', 'licensectl: Verlängerung für eine gezählte Installation belastet das Kontingent nicht', again.status === 0, again.err);
let toolSays = '';
try {
  lizenz.checkContingent(lizenz.readLedger(lines), { id: 'GP-2', total: 2 }, ids[2]);
} catch (e) {
  toolSays = e.message;
}
check('f', 'Werkzeug entscheidet gleich (dritte Installation abgewiesen)', /erschöpft \(2 von 2/.test(toolSays), toolSays);

// ---------- Bericht ----------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log((r.ok ? 'OK     ' : 'FEHLER ') + r.group + '  ' + r.name + (r.ok ? '' : '\n         ' + r.detail.split('\n').join('\n         ')));
}
console.log('\nGegenprobe: ' + (results.length - failed) + ' von ' + results.length + ' Prüfungen bestanden');
process.exit(failed === 0 ? 0 : 1);
