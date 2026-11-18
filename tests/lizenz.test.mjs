// Formate und Regeln der Lizenz. Die erwarteten Ergebnisse für License Request Files und die
// Ausgabe des Inhalts stammen aus Läufen von license.ParseRequest und json.Marshal (Go 1.27.4,
// Produkt-Commit 92a33a5, 2026-11-18).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lizenz = require('../js/lizenz.js');
const kodierung = require('../js/kodierung.js');
const { subtle } = globalThis.crypto;

const BASE = '{"format":"timerd-license-request/1","installationId":"0123456789abcdef0123456789abcdef"';
const req = (tail) => kodierung.utf8(BASE + tail);
const parse = (tail) => lizenz.parseRequest(req(tail));
const rejects = (tail, code) => assert.throws(() => parse(tail), (e) => e instanceof lizenz.LicenseError && e.code === code, tail);

// Schlüssel entstehen nur zur Laufzeit (keine privaten Schlüssel im Repository).
const PAIR = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const PUB = new Uint8Array(await subtle.exportKey('raw', PAIR.publicKey));
function testKey(kid) {
  return { kid, publicRaw: PUB, sign: async (b) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, PAIR.privateKey, b)) };
}

test('License Request File: angenommen wie license.ParseRequest', () => {
  for (const tail of [
    ',"created":"2026-11-18T10:00:00Z"}', ',"created":"2026-11-18T10:00:00\\u005a"}', ',"created":"2026-11-18T1:00:00Z"}',
    ',"created":"2026-11-18T10:00:00,5Z"}', ',"created":"2026-11-18T10:00:00.123456789123Z"}', ',"created":"0000-02-29T10:00:00Z"}',
    ',"created":null}', '}', '}  ', '\n}\n', ',"features":null}', ',"wishes":null}', ',"wishes":{}}',
    ',"wishes":{"packages":null,"type":null,"seats":null}}', ',"wishes":{"seats":-0}}', ',"reference":"é"}',
    ',"reference":"a\\u0000b"}', ',"reference":"' + '€'.repeat(80) + '"}', ',"version":null,"reference":null}',
  ]) {
    assert.doesNotThrow(() => parse(tail), tail);
  }
  assert.deepEqual(parse(',"features":{"a":null}}').features, new Map([['a', '']]));
  assert.deepEqual(parse(',"features":{"\\ud800":"x"}}').features, new Map([['\ufffd', 'x']]));
  assert.equal(parse(',"features":null}').features, null);
  assert.equal(parse(',"wishes":{}}').wishes, null);
  assert.equal(parse(',"wishes":{"seats":-0}}').wishes, null);
  assert.deepEqual(parse(',"wishes":{"packages":["mtdoe","trp"]}}').wishes, { type: '', seats: 0, packages: ['mtdoe', 'trp'] });
});

test('License Request File: abgewiesen wie license.ParseRequest', () => {
  for (const tail of [
    ',"created":"2026-11-18T10:00:00+00:00"}', ',"created":"2026-11-18T10:00:00-00:00"}', ',"created":"2026-11-18T10:00:00+01:00"}',
    ',"created":"2026-02-29T10:00:00Z"}', ',"created":"2026-11-18t10:00:00z"}', ',"created":"2026-11-18T24:00:00Z"}',
    ',"created":"2026-11-18T23:59:60Z"}', ',"created":"2026-11-18T10:00:00.Z"}', ',"created":"2026-11-18 10:00:00Z"}',
    ',"created":"+2026-11-18T10:00:00Z"}', ',"created":"2026-11-18T10:00Z"}', ',"created":""}', ',"created":1}',
    ',"features":{"a":1}}', ',"features":{"a":"b","a":"c"}}', ',"features":[]}',
    ',"wishes":{"seats":1.0}}', ',"wishes":{"seats":1e0}}', ',"wishes":{"seats":99999999999999999999}}', ',"wishes":{"seats":01}}',
    ',"wishes":{"seats":+1}}', ',"wishes":{"seats":1,"seats":2}}', ',"wishes":{"Seats":1}}', ',"wishes":[]}',
    ',"FORMAT":"x"}', ',"Format":"x"}', ',"INSTALLATIONID":"x"}', ',"version":1}', ',"extra":1}', '} x', ',"reference":"tab\ttab"}',
    ',"installationId":"0123456789abcdef0123456789abcdef"}', ',"reference":"' + '€'.repeat(81) + '"}',
  ]) {
    rejects(tail, 'format');
  }
  for (const text of ['null', '[]', '{}', '"x"', '{"format":"timerd-license-request/2","installationId":"0123456789abcdef0123456789abcdef"}',
    '{"format":"timerd-license-request/1","installationId":"0123456789ABCDEF0123456789ABCDEF"}']) {
    assert.throws(() => lizenz.parseRequest(kodierung.utf8(text)), (e) => e.code === 'format', text);
  }
  assert.throws(() => lizenz.parseRequest(new Uint8Array([0xef, 0xbb, 0xbf, ...req('}')])), (e) => e.code === 'format', 'BOM');
});

test('License Request File: Wunschangaben ungültig', () => {
  for (const tail of [',"wishes":{"seats":-1}}', ',"wishes":{"seats":10000}}', ',"wishes":{"packages":[null]}}',
    ',"wishes":{"packages":["trp","trp"]}}', ',"wishes":{"packages":["trp","mtdoe","trp"]}}', ',"wishes":{"type":"Event"}}',
    ',"wishes":{"packages":["TRP"]}}']) {
    rejects(tail, 'wishes');
  }
});

test('License Request File: Größe, UTF-8, verwechselte Datei', () => {
  const big = req(',"reference":"' + 'x'.repeat(16 << 10) + '"}');
  assert.throws(() => lizenz.parseRequest(big), (e) => e.code === 'format');
  // bewusst strenger als Go: ungültiges UTF-8 (Go ersetzt still, timerd schreibt es nie)
  const raw = req(',"reference":"X"}');
  raw[raw.length - 3] = 0xff;
  assert.throws(() => lizenz.parseRequest(raw), (e) => e.code === 'format' && /UTF-8/.test(e.message));
  const resp = kodierung.utf8('{"format":"timerd-license/1","kid":"x","payload":"y","sig":"z"}');
  assert.throws(() => lizenz.parseRequest(resp), (e) => e.code === 'is_response');
});

test('Vorbelegung wie licensectl serve: Käufer ohne Vorauswahl', () => {
  assert.deepEqual(lizenz.prefill(parse('}')), { buyer: '', customer: '', type: 'subscription', months: '12', updates: '12', seats: '1', packages: [], contingent: '' });
  const v = lizenz.prefill(parse(',"wishes":{"type":"event","seats":3,"packages":["mtdoe","trp"]}}'));
  assert.deepEqual([v.buyer, v.type, v.months, v.seats, v.packages], ['', 'subscription', '1', '3', ['trp', 'mtdoe']]);
  assert.equal(lizenz.prefill(parse(',"wishes":{"type":"perpetual"}}')).type, 'perpetual');
  assert.equal(lizenz.wishesText(parse(',"wishes":{"type":"event","seats":3,"packages":["trp","mtdoe"]}}').wishes),
    'Event-Lizenz 1 Monat, 3 Bedienplätze, Pakete TRP, Anzeigen-Master');
});

const form = (over) => ({ buyer: 'firma', customer: 'Hardwaretest', type: 'subscription', months: '12', updates: '12', seats: '1', packages: [], contingent: '', ...over });
const formFails = (over, code) => assert.throws(() => lizenz.checkForm(form(over)), (e) => e.code === code, JSON.stringify(over));

test('Eingaben wie formInput: Käufer und Kunde (EF-11)', () => {
  formFails({ buyer: '' }, 'buyer');
  formFails({ buyer: 'Firma' }, 'buyer');
  formFails({ buyer: 'privat', customer: 'Vorname Nachname' }, 'customer');
  formFails({ buyer: 'firma', customer: 'K-100234' }, 'customer');
  formFails({ customer: '   ' }, 'customer');
  formFails({ customer: 'A\u0007B' }, 'customer');
  formFails({ customer: 'A\u0085' + '\u0090' }, 'customer');
  formFails({ customer: 'x'.repeat(121) }, 'customer');
  assert.equal(lizenz.checkForm(form({ buyer: 'privat', customer: ' K-100234 ' })).customer, 'K-100234');
  assert.equal(lizenz.checkForm(form({ customer: '😀'.repeat(120) })).customer.length, 240);
  // Go trimmt U+0085 und U+3000, aber nicht U+FEFF (anders als String.trim)
  assert.equal(lizenz.checkForm(form({ customer: '　Hardwaretest\u0085 ' })).customer, 'Hardwaretest');
  assert.equal(lizenz.checkForm(form({ customer: '\ufeffX' })).customer, '\ufeffX');
  assert.equal(lizenz.checkForm(form({ customer: 'a\ud800' })).customer, 'a\ufffd');
});

test('Eingaben wie formInput: Art, Laufzeit, Plätze, Pakete, Kontingent', () => {
  formFails({ type: '' }, 'type');
  formFails({ type: 'event' }, 'type');
  for (const months of ['0', '121', '', '1e1', '1.5', ' 12']) formFails({ months }, 'months');
  assert.equal(lizenz.checkForm(form({ months: '012' })).months, 12);
  assert.equal(lizenz.checkForm(form({ months: '+5' })).months, 5);
  assert.equal(lizenz.checkForm(form({ type: 'perpetual', months: 'egal', updates: '0' })).updateMonths, 0);
  formFails({ type: 'perpetual', updates: '121' }, 'updates');
  formFails({ type: 'perpetual', updates: '-1' }, 'updates');
  for (const seats of ['0', '10000', '', 'x']) formFails({ seats }, 'seats');
  assert.equal(lizenz.checkForm(form({ seats: '9999' })).seats, 9999);
  formFails({ packages: ['TRP'] }, 'packages');
  assert.equal(lizenz.checkForm(form({ packages: [] })).packages, null);
  assert.deepEqual(lizenz.checkForm(form({ packages: ['trp', 'mtdoe'] })).packages, ['trp', 'mtdoe']);
  assert.deepEqual(lizenz.checkForm(form({ contingent: ' V-2026-01:5 ' })).contingent, { id: 'V-2026-01', total: 5 });
  for (const contingent of ['V:0', 'V:1234567', 'V W:1', 'x'.repeat(33) + ':1', ':1', 'V:', 'V:01', 'V:1:2']) formFails({ contingent }, 'contingent');
  assert.equal(lizenz.checkForm(form({ contingent: 'V:999999' })).contingent.total, 999999);
});

test('Zeitrechnung wie time.AddDate (Go)', () => {
  const t = (s) => new Date(s);
  for (const [from, n, want] of [
    ['2026-01-31T23:30:15Z', 1, '2026-03-03T23:30:15.000Z'], ['2028-01-31T23:30:15Z', 1, '2028-03-02T23:30:15.000Z'],
    ['2026-08-31T23:30:15Z', 6, '2027-03-03T23:30:15.000Z'], ['2026-12-31T23:30:15Z', 120, '2036-12-31T23:30:15.000Z'],
    ['2028-02-29T23:30:15Z', 12, '2029-03-01T23:30:15.000Z'],
  ]) {
    assert.equal(lizenz.addMonths(t(from), n).toISOString(), want, from);
  }
  assert.equal(lizenz.responseFileName('0123456789abcdef0123456789abcdef', t('2026-11-18T22:59:00Z')), 'virtualtimer-license-response-01234567-20261118.json');
});

const REQ1 = () => parse(',"features":{"mem.gib":"b","cpu.model":"a"},"reference":"Gegenprobe"}');
const NOW = new Date(Date.UTC(2026, 10, 18, 10, 0, 0, 500));
const ID1 = kodierung.fromHex('0123456789abcdef');

test('Inhalt der Lizenz wie json.Marshal(license.Payload)', () => {
  const input = lizenz.checkForm(form({ customer: 'Hardwaretest <&>', seats: '3', packages: ['trp', 'mtdoe'], contingent: 'V-2026-01:5' }));
  const p = lizenz.buildPayload(input, REQ1(), NOW, ID1);
  assert.equal(require('../js/gojson.js').marshal(p),
    '{"licenseId":"L-0123456789abcdef","customer":"Hardwaretest \\u003c\\u0026\\u003e","type":"subscription","issued":"2026-11-18T10:00:00Z","validFrom":"2026-11-17T10:00:00Z","validUntil":"2027-11-18T10:00:00Z","installationId":"0123456789abcdef0123456789abcdef","features":{"cpu.model":"a","mem.gib":"b"},"seats":3,"packages":["trp","mtdoe"],"contingent":{"id":"V-2026-01","total":5}}');
  const input2 = lizenz.checkForm(form({ buyer: 'privat', customer: 'K-100234', type: 'perpetual', updates: '0' }));
  const p2 = lizenz.buildPayload(input2, parse('}'), NOW, kodierung.fromHex('fedcba9876543210'));
  assert.equal(require('../js/gojson.js').marshal(p2),
    '{"licenseId":"L-fedcba9876543210","customer":"K-100234","type":"perpetual","issued":"2026-11-18T10:00:00Z","validFrom":"2026-11-17T10:00:00Z","installationId":"0123456789abcdef0123456789abcdef","features":null,"seats":1,"packages":null}');
  const p3 = lizenz.buildPayload({ ...input2, updateMonths: 3 }, parse(',"features":{}}'), NOW, ID1);
  assert.match(require('../js/gojson.js').marshal(p3), /"updatesUntil":"2027-02-18T10:00:00Z","installationId":"[0-9a-f]{32}","features":\{\},"seats":1,"packages":null\}$/);
});

test('Signatur über genau die Bytes des Inhalts; Hülle wie MarshalIndent', async () => {
  const key = testKey('test-einheit');
  const input = lizenz.checkForm(form({ seats: '2', packages: ['trp'] }));
  const r = await lizenz.issue(key, REQ1(), input, { now: NOW, idBytes: ID1, subtle });
  assert.ok(r.text.startsWith('{\n  "format": "timerd-license/1",\n  "kid": "test-einheit",\n  "payload": "'));
  assert.ok(r.text.endsWith('"\n}'));
  const env = JSON.parse(r.text);
  assert.deepEqual(Object.keys(env), ['format', 'kid', 'payload', 'sig']);
  const payloadBytes = kodierung.fromBase64url(env.payload);
  assert.equal(kodierung.fromUtf8(payloadBytes), require('../js/gojson.js').marshal(r.payload));
  const pub = await subtle.importKey('raw', PUB, { name: 'Ed25519' }, false, ['verify']);
  const sig = kodierung.fromBase64url(env.sig);
  assert.equal(await subtle.verify({ name: 'Ed25519' }, pub, sig, payloadBytes), true);
  assert.equal(await subtle.verify({ name: 'Ed25519' }, pub, sig, kodierung.utf8(env.payload)), false);
  assert.equal(await subtle.verify({ name: 'Ed25519' }, pub, sig, r.bytes), false);
  assert.equal(r.fileName, 'virtualtimer-license-response-01234567-20261118.json');
  const v = await lizenz.verifyLicense(r.bytes, new Map([['test-einheit', PUB]]), subtle);
  assert.equal(v.payload.licenseId, 'L-0123456789abcdef');
  assert.deepEqual(v.payload.packages, ['trp']);
});

test('Prüfung der Lizenz wie license.Verify: Fehlerfälle', async () => {
  const key = testKey('test-einheit');
  const keys = new Map([['test-einheit', PUB]]);
  const r = await lizenz.issue(key, REQ1(), lizenz.checkForm(form()), { now: NOW, idBytes: ID1, subtle });
  const env = JSON.parse(r.text);
  const again = (e) => kodierung.utf8(JSON.stringify(e));
  const code = async (bytes, want) => assert.rejects(lizenz.verifyLicense(bytes, keys, subtle), (e) => e.code === want, want);
  assert.equal((await lizenz.verifyLicense(r.bytes, keys, subtle)).kid, 'test-einheit');
  await code(again({ ...env, kid: 'test-anderer' }), 'key');
  const flipped = env.payload.slice(0, 10) + (env.payload[10] === 'A' ? 'B' : 'A') + env.payload.slice(11);
  await code(again({ ...env, payload: flipped }), 'signature');
  await code(again({ ...env, sig: env.sig.slice(1) }), 'signature');
  await code(again({ ...env, extra: 1 }), 'format');
  await code(again({ ...env, Format: env.format, format: undefined }), 'format');
  await code(kodierung.utf8(BASE + '}'), 'is_request');
  // gültig signiert, aber Inhalt mit anderer Schreibweise bzw. doppeltem Feld: content
  for (const text of [
    gojsonText(r.payload).replace('"seats"', '"Seats"'),
    gojsonText(r.payload).replace('"seats":1', '"seats":1,"seats":2'),
    gojsonText(r.payload).replace('"validUntil":"2027-11-18T10:00:00Z",', ''),
  ]) {
    const raw = kodierung.utf8(text);
    const sig = await key.sign(raw);
    await code(again({ format: 'timerd-license/1', kid: 'test-einheit', payload: kodierung.base64url(raw), sig: kodierung.base64url(sig) }), 'content');
  }
});

function gojsonText(p) {
  return require('../js/gojson.js').marshal(p);
}

test('Ausstellen nur mit Testschlüssel (Betriebsart test)', async () => {
  const input = lizenz.checkForm(form());
  for (const kid of ['2026-1', 'Test-1', 'prod-test-1', '']) {
    const key = testKey(kid);
    await assert.rejects(lizenz.issue(key, REQ1(), input, { now: NOW, idBytes: ID1, subtle }), (e) => e.code === 'mode', kid);
  }
  assert.equal(lizenz.isTestKid('test-1'), true);
  assert.equal(lizenz.isTestKid('Test-1'), false);
});

test('Zeile des Ausgabeprotokolls wie ledgerEntry (Betriebsart test)', async () => {
  const key = testKey('test-einheit');
  const input = lizenz.checkForm(form({ customer: 'Hardwaretest <&>', seats: '3', packages: ['trp', 'mtdoe'], contingent: 'V-2026-01:5' }));
  const r = await lizenz.issue(key, REQ1(), input, { now: NOW, idBytes: ID1, subtle });
  assert.equal(r.ledgerLine,
    '{"time":"2026-11-18T10:00:00Z","licenseId":"L-0123456789abcdef","kid":"test-einheit","customer":"Hardwaretest \\u003c\\u0026\\u003e","installationId":"0123456789abcdef0123456789abcdef","reference":"Gegenprobe","type":"subscription","validUntil":"2027-11-18T10:00:00Z","seats":3,"packages":["trp","mtdoe"],"contingent":"V-2026-01","features":{"cpu.model":"a","mem.gib":"b"},"mode":"test"}');
  // Privatkäufer: keine Referenz im Protokoll (EF-11); ohne Merkmale kein Feld features
  const priv = lizenz.checkForm(form({ buyer: 'privat', customer: 'K-7', type: 'perpetual', updates: '0' }));
  const r2 = await lizenz.issue(key, parse(',"reference":"Freitext des Käufers"}'), priv, { now: NOW, idBytes: ID1, subtle });
  assert.equal(r2.ledgerLine,
    '{"time":"2026-11-18T10:00:00Z","licenseId":"L-0123456789abcdef","kid":"test-einheit","customer":"K-7","installationId":"0123456789abcdef0123456789abcdef","type":"perpetual","seats":1,"packages":null,"mode":"test"}');
});

test('Kontingent wie checkContingent; beschädigtes Protokoll bricht ab', () => {
  const lines = [
    '{"licenseId":"L-1","installationId":"a","contingent":"V"}',
    '{"licenseId":"L-2","installationId":"b","contingent":"V"}',
    '{"licenseId":"L-3","installationId":"c","contingent":"W"}',
    '{"licenseId":"L-4","installationId":"a","contingent":"V"}',
  ];
  const entries = lizenz.readLedger(lines);
  assert.equal(lizenz.contingentUse(entries, 'V').size, 2);
  assert.throws(() => lizenz.checkContingent(entries, { id: 'V', total: 2 }, 'c'), /erschöpft \(2 von 2/);
  assert.doesNotThrow(() => lizenz.checkContingent(entries, { id: 'V', total: 2 }, 'a')); // Verlängerung belastet nicht
  assert.doesNotThrow(() => lizenz.checkContingent(entries, { id: 'V', total: 3 }, 'c'));
  assert.doesNotThrow(() => lizenz.checkContingent(entries, null, 'c'));
  assert.throws(() => lizenz.readLedger(['{"a":1}', '{kaputt']), /Zeile 2/);
  assert.throws(() => lizenz.readLedger(['[]']), /Zeile 1/);
});
