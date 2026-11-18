// Testschlüssel: Schlüsseldatei wie licensectl keygen (AL-17, AL-18), Erzeugen, Verschlüsseln mit
// Passphrase, Entsperren als nicht exportierbarer CryptoKey. Alle Schlüssel entstehen zur Laufzeit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schluessel = require('../js/schluessel.js');
const kodierung = require('../js/kodierung.js');
const { subtle } = globalThis.crypto;

const PASS = 'richtig lange Passphrase';

// keyFile baut eine Datei wie licensectl keygen: Kennungszeile, PEM mit 64 Zeichen je Zeile.
async function keyFile(kid, opts = {}) {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const der = opts.der || new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = kodierung.base64(der).match(/.{1,64}/g).join('\n');
  const type = opts.type || 'PRIVATE KEY';
  const head = kid === null ? '' : schluessel.KID_LABEL + ' ' + kid + '\n';
  const text = head + '-----BEGIN ' + type + '-----\n' + b64 + '\n-----END ' + type + '-----\n';
  return { text, der, pub: new Uint8Array(await subtle.exportKey('raw', pair.publicKey)) };
}

const fails = (fn, code) => assert.throws(fn, (e) => e instanceof schluessel.KeyError && e.code === code, code);
const failsAsync = (p, code) => assert.rejects(p, (e) => e instanceof schluessel.KeyError && e.code === code, code);

test('Schlüsseldatei aus licensectl keygen wird gelesen', async () => {
  const f = await keyFile('test-20261118-1200');
  const k = schluessel.parseKeyFile(f.text);
  assert.equal(k.kid, 'test-20261118-1200');
  assert.ok(kodierung.equal(k.pkcs8, f.der));
  assert.equal(schluessel.parseKeyFile(f.text.replace(/\n/g, '\r\n')).kid, 'test-20261118-1200');
  assert.equal(schluessel.parseKeyFile('  licensectl-kid:   test-a  \n' + f.text.split('\n').slice(1).join('\n')).kid, 'test-a');
  const m = await schluessel.fromKeyFile(f.text);
  assert.ok(kodierung.equal(m.publicRaw, f.pub));
  assert.match(schluessel.formatKey(m.kid, m.publicRaw), /^test-20261118-1200:[A-Za-z0-9+/]{43}=$/);
});

test('Nur Testschlüssel: Kennung ohne test- wird abgewiesen', async () => {
  for (const kid of ['2026-1', 'Test-1', 'prod', 'xtest-1', 'test']) {
    const f = await keyFile(kid);
    fails(() => schluessel.parseKeyFile(f.text), 'not_test');
  }
  for (const kid of ['test-ä', 'test-' + 'x'.repeat(28), 'test-a b', '']) {
    const f = await keyFile(kid);
    fails(() => schluessel.parseKeyFile(f.text), 'kid');
  }
});

test('Datei ohne Kennungszeile abgewiesen (AL-18), ebenso doppelte Zeile', async () => {
  const f = await keyFile(null);
  fails(() => schluessel.parseKeyFile(f.text), 'unbound');
  // eine Zeile nach dem PEM-Block zählt nicht
  fails(() => schluessel.parseKeyFile(f.text + 'licensectl-kid: test-a\n'), 'unbound');
  const g = await keyFile('test-a');
  fails(() => schluessel.parseKeyFile('licensectl-kid: test-a\n' + g.text), 'file');
});

test('Nur PKCS#8 Ed25519 im PEM-Block PRIVATE KEY', async () => {
  const ec = (await keyFile('test-a', { type: 'EC PRIVATE KEY' })).text;
  fails(() => schluessel.parseKeyFile(ec), 'file');
  const x25519 = kodierung.fromHex('302e020100300506032b656e04220420' + '11'.repeat(32));
  const x = (await keyFile('test-a', { der: x25519 })).text;
  fails(() => schluessel.parseKeyFile(x), 'file');
  fails(() => schluessel.parseKeyFile('licensectl-kid: test-a\n-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----\n'), 'file');
  fails(() => schluessel.parseKeyFile('licensectl-kid: test-a\n'), 'file');
  fails(() => schluessel.parseKeyFile('x'.repeat(20000)), 'file');
});

test('Neuer Schlüssel: Kennung test-JJJJMMTT-HHMM (UTC), PKCS#8 wie Go', async () => {
  assert.equal(schluessel.newKid(new Date(Date.UTC(2026, 10, 18, 9, 5, 59))), 'test-20261118-0905');
  const m = await schluessel.generate(new Date());
  assert.match(m.kid, /^test-[0-9]{8}-[0-9]{4}$/);
  assert.equal(m.pkcs8.length, 48);
  assert.equal(kodierung.hex(m.pkcs8.subarray(0, 16)), '302e020100300506032b657004220420');
  const priv = await subtle.importKey('pkcs8', m.pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const pub = await subtle.importKey('raw', m.publicRaw, { name: 'Ed25519' }, false, ['verify']);
  const sig = await subtle.sign({ name: 'Ed25519' }, priv, kodierung.utf8('x'));
  assert.equal(await subtle.verify({ name: 'Ed25519' }, pub, sig, kodierung.utf8('x')), true);
});

test('Passphrase: mindestens 12 Zeichen', () => {
  fails(() => schluessel.checkPassphrase('x'.repeat(11)), 'passphrase_short');
  assert.doesNotThrow(() => schluessel.checkPassphrase('x'.repeat(12)));
  fails(() => schluessel.checkPassphrase('😀'.repeat(11)), 'passphrase_short');
});

test('Verschlüsseln und Entsperren: richtige Passphrase, nicht exportierbar', async () => {
  const m = await schluessel.generate(new Date());
  const pub = m.publicRaw.slice();
  const seedB64 = kodierung.base64(m.pkcs8.subarray(16));
  const record = await schluessel.seal(m, PASS, new Date());
  assert.equal(record.kdf.iterations, 600000);
  const stored = JSON.stringify(record);
  assert.ok(!stored.includes(PASS), 'Passphrase steht nicht im Datensatz');
  assert.ok(!stored.includes(seedB64) && !stored.includes(kodierung.base64(m.pkcs8)), 'kein Klartextschlüssel im Datensatz');
  const k = await schluessel.unlock(record, PASS);
  assert.equal(k.kid, m.kid);
  assert.equal(k.privateKey.extractable, false);
  await assert.rejects(subtle.exportKey('pkcs8', k.privateKey));
  await assert.rejects(subtle.exportKey('jwk', k.privateKey));
  const sig = await k.sign(kodierung.utf8('Lizenz'));
  const pk = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await subtle.verify({ name: 'Ed25519' }, pk, sig, kodierung.utf8('Lizenz')), true);
});

test('Falsche Passphrase entsperrt nicht', async () => {
  const record = await schluessel.seal(await schluessel.generate(new Date()), PASS, new Date());
  for (const wrong of ['', 'falsche Passphrase!', PASS + ' ', PASS.toUpperCase()]) {
    await failsAsync(schluessel.unlock(record, wrong), 'passphrase');
  }
});

test('Veränderter Datensatz entsperrt nicht (AES-GCM mit Zusatzdaten)', async () => {
  const m = await schluessel.generate(new Date());
  const other = await schluessel.generate(new Date());
  const record = await schluessel.seal(m, PASS, new Date());
  await failsAsync(schluessel.unlock({ ...record, kid: 'test-anderer' }, PASS), 'passphrase');
  await failsAsync(schluessel.unlock({ ...record, publicKey: kodierung.base64(other.publicRaw) }, PASS), 'passphrase');
  const ct = kodierung.fromBase64(record.ciphertext);
  ct[5] ^= 1;
  await failsAsync(schluessel.unlock({ ...record, ciphertext: kodierung.base64(ct) }, PASS), 'passphrase');
  await failsAsync(schluessel.unlock({ ...record, kid: 'prod-1' }, PASS), 'not_test');
  await failsAsync(schluessel.unlock({ ...record, kdf: { ...record.kdf, iterations: 1000 } }, PASS), 'record');
  await failsAsync(schluessel.unlock({ ...record, format: 'x' }, PASS), 'record');
  await failsAsync(schluessel.unlock({ ...record, created: 'gestern' }, PASS), 'record');
  await failsAsync(schluessel.unlock({ ...record, cipher: { ...record.cipher, iv: 'AAAA' } }, PASS), 'record');
});

test('Verschlüsseln nur für Testschlüssel und mit ausreichender Passphrase', async () => {
  const m = await schluessel.generate(new Date());
  await failsAsync(schluessel.seal({ ...m, kid: '2026-1' }, PASS, new Date()), 'not_test');
  await failsAsync(schluessel.seal(m, 'kurz', new Date()), 'passphrase_short');
});
