/* Testschlüssel: Import einer Schlüsseldatei aus licensectl keygen, Erzeugen im Browser,
   Verschlüsseln mit Passphrase und Entsperren als nicht exportierbarer CryptoKey (WebCrypto).

   Regeln wie im Produkt (cmd/licensectl, readKey; ADR-0012 AL-17, AL-18):
   - Die Datei trägt vor dem PEM-Block die Zeile „licensectl-kid: <kid>“; sie bindet den Schlüssel
     an die Kennung. Dateien ohne diese Zeile weist die Betriebsart test ab (AL-18), dieses Werkzeug
     ebenso: So landet ein älterer Produktivschlüssel nicht unter einer Kennung test-… im Browser.
   - Nur Kennungen mit test- (license.TestKeyPrefix) und im Muster von licensectl (kidPattern).
   - Öffentlicher Schlüssel im Format von trustedKeysFlag bzw. TEST_LICENSE_KEY: kid:base64.

   Verschlüsselung: PBKDF2-HMAC-SHA-256 mit 600 000 Iterationen (Empfehlung der OWASP für
   PBKDF2-SHA-256, Password Storage Cheat Sheet, Stand 2023) und AES-256-GCM. Die Zusatzdaten (AAD)
   binden Format, Kennung und öffentlichen Schlüssel an den Geheimtext. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./kodierung.js'), require('./lizenz.js'));
  else (root.VTL = root.VTL || {}).schluessel = factory(root.VTL.kodierung, root.VTL.lizenz);
})(typeof self !== 'undefined' ? self : globalThis, function (kodierung, lizenz) {
  'use strict';

  const KID_LABEL = 'licensectl-kid:';
  const RECORD_FORMAT = 'vt-testlizenz-schluessel/1';
  const ITERATIONS = 600000;
  const MAX_ITERATIONS = 10000000; // Grenze gegen einen veränderten Datensatz (Rechenzeit)
  const MIN_PASSPHRASE = 12;
  const MAX_KEY_FILE = 16 << 10;
  // PKCS#8 eines Ed25519-Schlüssels, wie x509.MarshalPKCS8PrivateKey in Go ihn schreibt (RFC 8410):
  // 16 Bytes Kopf, dann der 32-Byte-Seed.
  const PKCS8_PREFIX = kodierung.fromHex('302e020100300506032b657004220420');
  const ED25519 = { name: 'Ed25519' };

  class KeyError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function subtle() {
    return globalThis.crypto.subtle;
  }

  function randomBytes(n) {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
  }

  // checkKid: Muster von licensectl und nur Testschlüssel.
  function checkKid(kid) {
    if (!lizenz.KID_PATTERN.test(kid)) {
      throw new KeyError('kid', 'Kennung ungültig: 1 bis 32 Zeichen aus Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich');
    }
    if (!lizenz.isTestKid(kid)) {
      throw new KeyError('not_test', 'Nur Testschlüssel: Die Kennung muss mit test- beginnen („' + kid + '“ ist keine). Produktivschlüssel bleiben am Signierrechner (O-4).');
    }
  }

  function isEd25519Pkcs8(der) {
    return der instanceof Uint8Array && der.length === 48 && kodierung.equal(der.subarray(0, 16), PKCS8_PREFIX);
  }

  // decodePem sucht wie pem.Decode den ersten Block (am Anfang oder nach einem Zeilenende) und
  // verlangt den Typ PRIVATE KEY ohne Kopfzeilen.
  function decodePem(text) {
    const begin = /(?:^|\n)-----BEGIN ([^\n]*?)-----[ \t\r]*\n/.exec(text);
    if (!begin || begin[1] !== 'PRIVATE KEY') return null;
    const rest = text.slice(begin.index + begin[0].length);
    const end = rest.indexOf('-----END PRIVATE KEY-----');
    if (end < 0) return null;
    const body = rest.slice(0, end).replace(/[ \t\r\n]/g, '');
    return kodierung.fromBase64(body);
  }

  // parseKeyFile wie readKey in licensectl für die Betriebsart test.
  function parseKeyFile(text) {
    if (typeof text !== 'string' || text.length > MAX_KEY_FILE) throw new KeyError('file', 'Schlüsseldatei zu groß');
    let kid = null;
    for (const line of text.split('\n').map(lizenz.trimSpace)) {
      if (line.startsWith('-----BEGIN ')) break;
      if (line.startsWith(KID_LABEL)) {
        if (kid !== null) throw new KeyError('file', 'Schlüsseldatei mit mehr als einer Zeile ' + KID_LABEL);
        kid = lizenz.trimSpace(line.slice(KID_LABEL.length));
      }
    }
    const der = decodePem(text);
    if (!der) throw new KeyError('file', 'Kein privater Schlüssel (PEM-Block PRIVATE KEY) gefunden');
    if (!isEd25519Pkcs8(der)) throw new KeyError('file', 'Kein Ed25519-Schlüssel im Format von licensectl keygen (PKCS#8)');
    if (kid === null) {
      throw new KeyError('unbound', 'Schlüsseldatei ohne Zeile „' + KID_LABEL + ' test-…“ vor dem PEM-Block. Testschlüssel brauchen die Kennung in der Datei (ADR-0012 AL-18): neu erzeugen oder die Zeile ergänzen.');
    }
    checkKid(kid);
    return { kid, pkcs8: der };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // newKid: test-JJJJMMTT-HHMM in UTC.
  function newKid(now) {
    return 'test-' + now.getUTCFullYear() + pad2(now.getUTCMonth() + 1) + pad2(now.getUTCDate()) + '-' + pad2(now.getUTCHours()) + pad2(now.getUTCMinutes());
  }

  // keyMaterial liest Seed und öffentlichen Schlüssel aus einem (kurz) exportierbaren Schlüssel.
  async function keyMaterial(privateKey) {
    const jwk = await subtle().exportKey('jwk', privateKey);
    const seed = kodierung.fromBase64url(jwk.d);
    const pub = kodierung.fromBase64url(jwk.x);
    if (!seed || seed.length !== 32 || !pub || pub.length !== 32) throw new KeyError('crypto', 'Schlüssel nicht lesbar');
    const pkcs8 = new Uint8Array(48);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(seed, 16);
    seed.fill(0);
    return { pkcs8, publicRaw: pub };
  }

  // generate erzeugt einen neuen Testschlüssel; pkcs8 dient nur dem Verschlüsseln (seal).
  async function generate(now) {
    const kid = newKid(now);
    const pair = await subtle().generateKey(ED25519, true, ['sign', 'verify']);
    const m = await keyMaterial(pair.privateKey);
    return { kid, pkcs8: m.pkcs8, publicRaw: m.publicRaw };
  }

  // fromKeyFile liest eine Schlüsseldatei und leitet den öffentlichen Schlüssel ab.
  async function fromKeyFile(text) {
    const f = parseKeyFile(text);
    const priv = await subtle().importKey('pkcs8', f.pkcs8, ED25519, true, ['sign']);
    const m = await keyMaterial(priv);
    f.pkcs8.fill(0);
    return { kid: f.kid, pkcs8: m.pkcs8, publicRaw: m.publicRaw };
  }

  // formatKey wie license.FormatKey: Eintrag für trustedKeysFlag, TEST_LICENSE_KEY und -keys.
  function formatKey(kid, publicRaw) {
    return kid + ':' + kodierung.base64(publicRaw);
  }

  function checkPassphrase(passphrase) {
    if (typeof passphrase !== 'string' || Array.from(passphrase).length < MIN_PASSPHRASE) {
      throw new KeyError('passphrase_short', 'Passphrase zu kurz: mindestens ' + MIN_PASSPHRASE + ' Zeichen');
    }
  }

  async function deriveKey(passphrase, salt, iterations) {
    const base = await subtle().importKey('raw', kodierung.utf8(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function additionalData(kid, publicB64) {
    return kodierung.utf8(RECORD_FORMAT + '\n' + kid + '\n' + publicB64);
  }

  // seal verschlüsselt den Schlüssel für die Ablage im Browser. Die Passphrase wird nicht abgelegt.
  async function seal(material, passphrase, now, opts) {
    checkKid(material.kid);
    checkPassphrase(passphrase);
    if (!isEd25519Pkcs8(material.pkcs8)) throw new KeyError('crypto', 'Schlüssel nicht im erwarteten Format');
    const iterations = (opts && opts.iterations) || ITERATIONS;
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const publicB64 = kodierung.base64(material.publicRaw);
    const aes = await deriveKey(passphrase, salt, iterations);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(material.kid, publicB64) }, aes, material.pkcs8);
    return {
      format: RECORD_FORMAT,
      kid: material.kid,
      publicKey: publicB64,
      kdf: { name: 'PBKDF2-SHA-256', iterations, salt: kodierung.base64(salt) },
      cipher: { name: 'AES-256-GCM', iv: kodierung.base64(iv) },
      ciphertext: kodierung.base64(new Uint8Array(ct)),
      created: now.toISOString(),
    };
  }

  // checkRecord prüft einen abgelegten Datensatz vor jeder Verwendung.
  function checkRecord(r) {
    const ok = r && r.format === RECORD_FORMAT && typeof r.kid === 'string' && r.kdf && r.cipher &&
      r.kdf.name === 'PBKDF2-SHA-256' && Number.isInteger(r.kdf.iterations) && r.kdf.iterations >= ITERATIONS &&
      r.kdf.iterations <= MAX_ITERATIONS && r.cipher.name === 'AES-256-GCM' && typeof r.created === 'string' && !Number.isNaN(Date.parse(r.created));
    if (!ok) throw new KeyError('record', 'Abgelegter Schlüssel hat ein unbekanntes Format');
    checkKid(r.kid);
    const pub = kodierung.fromBase64(r.publicKey);
    const salt = kodierung.fromBase64(r.kdf.salt);
    const iv = kodierung.fromBase64(r.cipher.iv);
    const ct = kodierung.fromBase64(r.ciphertext);
    if (!pub || pub.length !== 32 || !salt || salt.length !== 16 || !iv || iv.length !== 12 || !ct || ct.length !== 48 + 16) {
      throw new KeyError('record', 'Abgelegter Schlüssel ist beschädigt');
    }
    return { pub, salt, iv, ct };
  }

  // unlock entschlüsselt den Datensatz und liefert den privaten Schlüssel nur als nicht
  // exportierbaren CryptoKey. Eine falsche Passphrase oder ein veränderter Datensatz scheitert an
  // der Prüfung von AES-GCM.
  async function unlock(record, passphrase) {
    const r = checkRecord(record);
    const aes = await deriveKey(String(passphrase), r.salt, record.kdf.iterations);
    let plain;
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: r.iv, additionalData: additionalData(record.kid, record.publicKey) }, aes, r.ct));
    } catch (e) {
      throw new KeyError('passphrase', 'Passphrase falsch oder abgelegter Schlüssel verändert');
    }
    try {
      if (!isEd25519Pkcs8(plain)) throw new KeyError('record', 'Abgelegter Schlüssel ist beschädigt');
      const privateKey = await subtle().importKey('pkcs8', plain, ED25519, false, ['sign']);
      const publicKey = await subtle().importKey('raw', r.pub, ED25519, true, ['verify']);
      // Gegenprobe: Der private Schlüssel gehört zum abgelegten öffentlichen.
      const probe = kodierung.utf8('vt-testlizenz-probe');
      const sig = await subtle().sign(ED25519, privateKey, probe);
      if (!(await subtle().verify(ED25519, publicKey, sig, probe))) throw new KeyError('record', 'Schlüsselpaar passt nicht zusammen');
      return {
        kid: record.kid,
        publicRaw: r.pub,
        privateKey,
        sign: async (bytes) => new Uint8Array(await subtle().sign(ED25519, privateKey, bytes)),
      };
    } finally {
      plain.fill(0);
    }
  }

  return {
    KID_LABEL,
    RECORD_FORMAT,
    ITERATIONS,
    MIN_PASSPHRASE,
    KeyError,
    checkKid,
    parseKeyFile,
    newKid,
    generate,
    fromKeyFile,
    formatKey,
    checkPassphrase,
    seal,
    checkRecord,
    unlock,
  };
});
