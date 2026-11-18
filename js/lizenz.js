/* Formate und Regeln der Lizenz wie im Produkt (maßgeblich: virtual-timer-projektstruktur-v3):
   - License Request File lesen wie license.ParseRequest (internal/license/license.go) mit
     license.DecodeStrict (strict.go);
   - Eingaben prüfen wie die Oberfläche von licensectl serve (formInput) und der gemeinsame
     Ausstellungsweg issue() in cmd/licensectl/main.go;
   - Lizenz kodieren wie license.Encode: Inhalt mit json.Marshal, Signatur Ed25519 über genau diese
     Bytes, Hülle mit json.MarshalIndent;
   - Zeile des Ausgabeprotokolls wie ledgerEntry in licensectl.
   Abweichung, bewusst strenger: ungültiges UTF-8 im License Request File ist ein Fehler (Go ersetzt
   es still; timerd schreibt es nie). */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./gojson.js'), require('./kodierung.js'));
  else (root.VTL = root.VTL || {}).lizenz = factory(root.VTL.gojson, root.VTL.kodierung);
})(typeof self !== 'undefined' ? self : globalThis, function (gojson, kodierung) {
  'use strict';

  const REQUEST_FORMAT = 'timerd-license-request/1';
  const LICENSE_FORMAT = 'timerd-license/1';
  const MAX_FILE_SIZE = 16 << 10; // license.MaxFileSize
  const MAX_SEATS = 9999; // license.MaxSeats
  const MAX_REFERENCE = 80; // license.MaxReference
  const MAX_MONTHS = 120; // licensectl maxMonths
  const MAX_CUSTOMER = 120; // licensectl serve maxCustomer
  const CLOCK_TOLERANCE_MS = 24 * 3600 * 1000; // licensectl clockTolerance (N-5)
  const TEST_KEY_PREFIX = 'test-'; // license.TestKeyPrefix
  const MODE_TEST = 'test';

  const TYPE_SUBSCRIPTION = 'subscription';
  const TYPE_PERPETUAL = 'perpetual';
  const PACKAGE_TRP = 'trp';
  const PACKAGE_DISPLAY_MASTER = 'mtdoe'; // Paketkennung; angezeigt als „Anzeigen-Master“
  const PACKAGES = [PACKAGE_TRP, PACKAGE_DISPLAY_MASTER];
  const PACKAGE_NAMES = { [PACKAGE_TRP]: 'TRP', [PACKAGE_DISPLAY_MASTER]: 'Anzeigen-Master' };

  const ID_PATTERN = /^[0-9a-f]{32}$/;
  const KID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
  const CUSTOMER_NUMBER = /^K-[0-9]{1,12}$/;
  const CONTINGENT_PATTERN = /^[A-Za-z0-9._-]{1,32}:[1-9][0-9]{0,5}$/;

  const MSG_FORMAT = 'Datei hat ein unbekanntes Format oder ist zu groß';
  const MSG_IS_RESPONSE = 'Datei ist ein License Response File (Lizenz), kein License Request File';
  const MSG_IS_REQUEST = 'Datei ist ein License Request File (Anfrage an den Hersteller), kein License Response File';
  const MSG_WISHES = 'Wunschangaben ungültig: Art subscription, event oder perpetual; 1 bis 9999 Bedienplätze; Pakete trp, mtdoe (Anzeigen-Master) ohne Doppelung';
  const MSG_CONTENT = 'Lizenz ist unvollständig oder widersprüchlich';

  class LicenseError extends Error {
    constructor(code, message, detail) {
      super(detail ? message + ' (' + detail + ')' : message);
      this.code = code;
    }
  }

  // ---------- Zeichenregeln wie Go ----------

  // isSpace wie unicode.IsSpace (Grundlage von strings.TrimSpace); weicht von String.trim ab
  // (U+0085 ja, U+FEFF nein).
  function isSpace(c) {
    return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  }

  function trimSpace(text) {
    let a = 0;
    let b = text.length;
    while (a < b && isSpace(text.charCodeAt(a))) a++;
    while (b > a && isSpace(text.charCodeAt(b - 1))) b--;
    return text.slice(a, b);
  }

  // hasControl wie strings.IndexFunc(s, unicode.IsControl) >= 0: nur C0, DEL und C1.
  function hasControl(text) {
    return /[\u0000-\u001f\u007f-\u009f]/.test(text);
  }

  function runeCount(text) {
    return Array.from(text).length;
  }

  function isTestKid(kid) {
    return typeof kid === 'string' && kid.startsWith(TEST_KEY_PREFIX);
  }

  // ---------- Zeitpunkte ----------

  function daysIn(month, year) {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function utcDate(y, mo, d, h, mi, s) {
    const t = new Date(0);
    t.setUTCFullYear(y, mo, d); // ohne die Zweistellig-Regel von Date.UTC, Überlauf wie time.Date
    t.setUTCHours(h, mi, s, 0);
    return t;
  }

  // parseTime liest RFC 3339 wie time.Time.UnmarshalJSON der Toolchain des Produkts (Go 1.27.4,
  // gemessen 2026-11-18): Stunde ein- oder zweistellig, Bruch mit Punkt oder Komma. Liefert
  // { date, utc } oder null.
  function parseTime(text) {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:[.,]([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(text);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > daysIn(mo, y) || h > 23 || mi > 59 || s > 59) return null;
    let offset = 0;
    if (m[8] !== 'Z') {
      const oh = Number(m[8].slice(1, 3));
      const om = Number(m[8].slice(4, 6));
      if (oh > 23 || om > 59) return null;
      offset = (m[8][0] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
    }
    const date = new Date(utcDate(y, mo - 1, d, h, mi, s).getTime() - offset);
    const ms = m[7] ? Number(('0.' + m[7]).slice(0, 5)) * 1000 : 0;
    return { date: new Date(date.getTime() + Math.floor(ms)), utc: m[8] === 'Z' };
  }

  function addMonths(t, months) {
    return utcDate(t.getUTCFullYear(), t.getUTCMonth() + months, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
  }

  function ymd(t) {
    return gojson.formatTime(new Date(Math.floor(t.getTime() / 1000) * 1000)).slice(0, 10).replace(/-/g, '');
  }

  // ---------- License Request File ----------

  // hasFormat: nachsichtig wie json.Unmarshal (Schreibweise egal, letzter Wert gilt); nur für eine
  // verständliche Meldung bei verwechselten Dateien.
  function hasFormat(text, format) {
    try {
      const node = gojson.parse(text, { allowDuplicates: true });
      if (node.kind !== 'object') return false;
      let found = '';
      for (const [k, v] of node.fields) if (k.toLowerCase() === 'format' && v.kind === 'string') found = v.value;
      return found === format;
    } catch (e) {
      return false;
    }
  }

  function decodeText(bytes) {
    try {
      return kodierung.fromUtf8(bytes);
    } catch (e) {
      throw new LicenseError('format', MSG_FORMAT, 'kein gültiges UTF-8');
    }
  }

  // parseRequest wie license.ParseRequest. Wirft LicenseError mit code format, is_response oder wishes.
  function parseRequest(bytes) {
    if (bytes.length > MAX_FILE_SIZE) throw new LicenseError('format', MSG_FORMAT, 'größer als 16 KiB');
    const text = decodeText(bytes);
    let req;
    try {
      req = decodeRequest(text);
    } catch (e) {
      if (!(e instanceof gojson.JsonError)) throw e;
      if (hasFormat(text, LICENSE_FORMAT)) throw new LicenseError('is_response', MSG_IS_RESPONSE);
      throw new LicenseError('format', MSG_FORMAT, e.message);
    }
    if (req.format !== REQUEST_FORMAT) {
      if (hasFormat(text, LICENSE_FORMAT)) throw new LicenseError('is_response', MSG_IS_RESPONSE);
      throw new LicenseError('format', MSG_FORMAT, 'Feld format ist nicht ' + REQUEST_FORMAT);
    }
    if (!ID_PATTERN.test(req.installationId)) throw new LicenseError('format', MSG_FORMAT, 'Installations-ID ungültig');
    if (runeCount(req.reference) > MAX_REFERENCE) throw new LicenseError('format', MSG_FORMAT, 'Referenz länger als 80 Zeichen');
    if (req.created !== null && !req.created.utc) throw new LicenseError('format', MSG_FORMAT, 'created nicht in UTC (Z)');
    if (req.wishes !== null) {
      validateWishes(req.wishes);
      if (req.wishes.type === '' && req.wishes.seats === 0 && req.wishes.packages.length === 0) req.wishes = null;
    }
    return req;
  }

  function decodeRequest(text) {
    const root = gojson.parse(text);
    // null ergibt in Go die leere Struktur; sie scheitert danach am Format.
    const f = root.kind === 'null' ? new Map() :
      gojson.fieldsOf(root, ['format', 'installationId', 'features', 'version', 'created', 'reference', 'wishes']);
    const req = {
      format: gojson.asString(f.get('format')),
      installationId: gojson.asString(f.get('installationId')),
      features: gojson.asStringMap(f.get('features')),
      version: gojson.asString(f.get('version')),
      created: null,
      reference: gojson.asString(f.get('reference')),
      wishes: null,
    };
    const created = f.get('created');
    if (created !== undefined && created.kind !== 'null') {
      if (created.kind !== 'string') throw new gojson.JsonError('created: Text erwartet');
      req.created = parseTime(created.value);
      if (req.created === null) throw new gojson.JsonError('created: kein Zeitpunkt nach RFC 3339');
    }
    const w = f.get('wishes');
    if (w !== undefined && w.kind !== 'null') {
      const wf = gojson.fieldsOf(w, ['type', 'seats', 'packages']);
      req.wishes = {
        type: gojson.asString(wf.get('type')),
        seats: gojson.asInt(wf.get('seats')),
        packages: gojson.asStringList(wf.get('packages')) || [],
      };
    }
    return req;
  }

  // validateWishes wie Wishes.Validate.
  function validateWishes(w) {
    const okType = ['', 'subscription', 'event', 'perpetual'].includes(w.type);
    if (!okType || w.seats < 0 || w.seats > MAX_SEATS || w.packages.length > 2) throw new LicenseError('wishes', MSG_WISHES);
    w.packages.forEach((p, i) => {
      if (!PACKAGES.includes(p) || w.packages.slice(0, i).includes(p)) throw new LicenseError('wishes', MSG_WISHES);
    });
  }

  function packagesText(list) {
    return list && list.length ? list.map((p) => PACKAGE_NAMES[p] || p).join(', ') : 'keine';
  }

  // wishesText wie in licensectl, mit den Anzeigenamen der Pakete.
  function wishesText(w) {
    if (!w) return 'keine';
    const parts = [];
    if (w.type === 'subscription') parts.push('Laufzeitlizenz 12 Monate');
    if (w.type === 'event') parts.push('Event-Lizenz 1 Monat');
    if (w.type === 'perpetual') parts.push('Dauerlizenz');
    if (w.seats > 0) parts.push(w.seats + ' Bedienplätze');
    if (w.packages.length) parts.push('Pakete ' + packagesText(w.packages));
    return parts.join(', ');
  }

  function typeText(type, months) {
    if (type === TYPE_PERPETUAL) return 'Dauerlizenz';
    if (months === 1) return 'Laufzeitlizenz 1 Monat (Event-Lizenz)';
    return 'Laufzeitlizenz ' + months + ' Monate';
  }

  // prefill wie in licensectl serve: Standardwerte, überschrieben von den Wünschen. Die Käuferart
  // bleibt ohne Vorauswahl (EF-11).
  function prefill(req) {
    const v = { buyer: '', customer: '', type: TYPE_SUBSCRIPTION, months: '12', updates: '12', seats: '1', packages: [], contingent: '' };
    const w = req.wishes;
    if (w) {
      if (w.type === 'event') v.months = '1';
      if (w.type === 'perpetual') v.type = TYPE_PERPETUAL;
      if (w.seats > 0) v.seats = String(w.seats);
      v.packages = PACKAGES.filter((p) => w.packages.includes(p));
    }
    return v;
  }

  // ---------- Eingaben (formInput und issue in licensectl) ----------

  // atoi wie strconv.Atoi (64 Bit); null bei Fehler.
  function atoi(text) {
    if (!/^[+-]?[0-9]+$/.test(text)) return null;
    const v = BigInt(text);
    if (v < -(2n ** 63n) || v > 2n ** 63n - 1n) return null;
    return v > 1000000n ? 1000001 : v < -1000000n ? -1000001 : Number(v);
  }

  function checkCustomer(value, isPrivate) {
    if (isPrivate && !CUSTOMER_NUMBER.test(value)) {
      throw new LicenseError('customer', 'Kundennummer ungültig: erwartet K- und 1 bis 12 Ziffern, z. B. K-100234; bei Privatkäufern steht nie ein Name in der Lizenz (EF-11)');
    }
    if (isPrivate) return;
    if (value === '') throw new LicenseError('customer', 'Kunde fehlt');
    if (CUSTOMER_NUMBER.test(value)) {
      throw new LicenseError('customer', 'Firmenname hat das Format einer Kundennummer; bei Privatkäufern die Kundennummer als solche angeben (EF-11)');
    }
  }

  // checkForm prüft die Werte des Formulars (Texte wie aus dem Browser) in der Reihenfolge von
  // formInput und liefert die Ausstellungswerte.
  function checkForm(v) {
    let isPrivate;
    if (v.buyer === 'firma') isPrivate = false;
    else if (v.buyer === 'privat') isPrivate = true;
    else throw new LicenseError('buyer', 'Käufer wählen: Firma oder Privatperson');
    const customer = trimSpace(gojson.wellFormed(v.customer || ''));
    if (customer === '' || runeCount(customer) > MAX_CUSTOMER || hasControl(customer)) {
      throw new LicenseError('customer', 'Kunde fehlt, ist länger als ' + MAX_CUSTOMER + ' Zeichen oder enthält Steuerzeichen');
    }
    checkCustomer(customer, isPrivate);
    const type = v.type;
    if (type !== TYPE_SUBSCRIPTION && type !== TYPE_PERPETUAL) throw new LicenseError('type', 'Art unbekannt');
    let months = 0;
    let updates = 0;
    if (type === TYPE_SUBSCRIPTION) {
      months = atoi(v.months || '');
      if (months === null || months < 1 || months > MAX_MONTHS) throw new LicenseError('months', 'Laufzeit: 1 bis ' + MAX_MONTHS + ' Monate');
    } else {
      updates = atoi(v.updates || '');
      if (updates === null || updates < 0 || updates > MAX_MONTHS) throw new LicenseError('updates', 'Update-Zeitraum: 0 bis ' + MAX_MONTHS + ' Monate');
    }
    const seats = atoi(v.seats || '');
    if (seats === null || seats < 1 || seats > MAX_SEATS) throw new LicenseError('seats', 'Bedienplätze: 1 bis ' + MAX_SEATS);
    const packages = v.packages || [];
    for (const p of packages) if (!PACKAGES.includes(p)) throw new LicenseError('packages', 'Paket „' + p + '“ unbekannt');
    const contingent = trimSpace(v.contingent || '');
    if (contingent !== '' && !CONTINGENT_PATTERN.test(contingent)) {
      throw new LicenseError('contingent', 'Kontingent: Kennung:Anzahl, z. B. V-2026-01:5');
    }
    return {
      customer,
      isPrivate,
      type,
      months,
      updateMonths: updates,
      seats,
      // Ohne Häkchen ist die Liste in Go nil und steht als null in der Lizenz.
      packages: packages.length ? packages.slice() : null,
      contingent: contingent === '' ? null : { id: contingent.split(':')[0], total: Number(contingent.split(':')[1]) },
    };
  }

  function checkMode(kid) {
    if (!isTestKid(kid)) {
      throw new LicenseError('mode', 'Betriebsart test nur mit einem Testschlüssel (kid ' + TEST_KEY_PREFIX + '…); ' + kid + ' ist keiner');
    }
  }

  // ---------- Inhalt und Hülle der Lizenz ----------

  // buildPayload wie issue(): Ausstellung auf ganze Sekunden, gültig ab 24 h davor (N-5), Laufzeit
  // ab der Ausstellung. Die Felder stehen in der Reihenfolge von license.Payload.
  function buildPayload(input, req, now, idBytes) {
    if (!(idBytes instanceof Uint8Array) || idBytes.length !== 8) throw new Error('Lizenz-ID braucht 8 Zufallsbytes');
    const t = new Date(Math.floor(now.getTime() / 1000) * 1000);
    return {
      licenseId: 'L-' + kodierung.hex(idBytes),
      customer: input.customer,
      type: input.type,
      issued: t,
      validFrom: new Date(t.getTime() - CLOCK_TOLERANCE_MS),
      validUntil: input.type === TYPE_SUBSCRIPTION ? addMonths(t, input.months) : undefined,
      updatesUntil: input.type === TYPE_PERPETUAL && input.updateMonths > 0 ? addMonths(t, input.updateMonths) : undefined,
      installationId: req.installationId,
      features: req.features,
      seats: input.seats,
      packages: input.packages,
      contingent: input.contingent ? { id: input.contingent.id, total: input.contingent.total } : undefined,
    };
  }

  const ZERO_TIME = Date.parse('0001-01-01T00:00:00Z');

  // validatePayload wie Payload.validate.
  function validatePayload(p) {
    const zero = (d) => !d || d.getTime() === ZERO_TIME; // time.Time.IsZero
    const bad =
      p.licenseId === '' || p.customer === '' || !ID_PATTERN.test(p.installationId) || zero(p.validFrom) ||
      (p.type === TYPE_SUBSCRIPTION && !p.validUntil) ||
      (p.type === TYPE_PERPETUAL && p.validUntil) ||
      (p.type !== TYPE_SUBSCRIPTION && p.type !== TYPE_PERPETUAL) ||
      (p.validUntil && !(p.validUntil.getTime() > p.validFrom.getTime())) ||
      !(p.seats >= 1);
    if (bad) throw new LicenseError('content', MSG_CONTENT);
    for (const pkg of p.packages || []) {
      if (!PACKAGES.includes(pkg)) throw new LicenseError('content', MSG_CONTENT, 'Paket „' + pkg + '“');
    }
  }

  // encodeLicense wie license.Encode: sign(bytes) signiert genau die Bytes des Inhalts.
  async function encodeLicense(payload, kid, sign) {
    validatePayload(payload);
    const raw = kodierung.utf8(gojson.marshal(payload));
    const sig = await sign(raw);
    const text = gojson.marshalIndentFlat({
      format: LICENSE_FORMAT,
      kid,
      payload: kodierung.base64url(raw),
      sig: kodierung.base64url(new Uint8Array(sig)),
    });
    return { text, bytes: kodierung.utf8(text), payloadBytes: raw };
  }

  function decodePayload(text) {
    const f = gojson.fieldsOf(gojson.parse(text), ['licenseId', 'customer', 'type', 'issued', 'validFrom', 'validUntil',
      'updatesUntil', 'installationId', 'features', 'seats', 'packages', 'contingent']);
    const time = (key) => {
      const n = f.get(key);
      if (n === undefined || n.kind === 'null') return undefined;
      if (n.kind !== 'string') throw new gojson.JsonError(key + ': Text erwartet');
      const t = parseTime(n.value);
      if (!t) throw new gojson.JsonError(key + ': kein Zeitpunkt');
      return t.date;
    };
    let contingent;
    const c = f.get('contingent');
    if (c !== undefined && c.kind !== 'null') {
      const cf = gojson.fieldsOf(c, ['id', 'total']);
      contingent = { id: gojson.asString(cf.get('id')), total: gojson.asInt(cf.get('total')) };
    }
    return {
      licenseId: gojson.asString(f.get('licenseId')),
      customer: gojson.asString(f.get('customer')),
      type: gojson.asString(f.get('type')),
      issued: time('issued'),
      validFrom: time('validFrom'),
      validUntil: time('validUntil'),
      updatesUntil: time('updatesUntil'),
      installationId: gojson.asString(f.get('installationId')),
      features: gojson.asStringMap(f.get('features')),
      seats: gojson.asInt(f.get('seats')),
      packages: gojson.asStringList(f.get('packages')),
      contingent,
    };
  }

  // verifyLicense wie license.Verify: Größe, Hülle, Schlüssel, Signatur über die Bytes des Inhalts,
  // erst danach der Inhalt. keys: Map kid → öffentlicher Schlüssel (32 Bytes).
  async function verifyLicense(bytes, keys, subtle) {
    if (bytes.length > MAX_FILE_SIZE) throw new LicenseError('format', MSG_FORMAT);
    const text = decodeText(bytes);
    let env;
    try {
      const f = gojson.fieldsOf(gojson.parse(text), ['format', 'kid', 'payload', 'sig']);
      env = { format: gojson.asString(f.get('format')), kid: gojson.asString(f.get('kid')),
        payload: gojson.asString(f.get('payload')), sig: gojson.asString(f.get('sig')) };
    } catch (e) {
      if (!(e instanceof gojson.JsonError)) throw e;
      env = null;
    }
    if (!env || env.format !== LICENSE_FORMAT) {
      if (hasFormat(text, REQUEST_FORMAT)) throw new LicenseError('is_request', MSG_IS_REQUEST);
      throw new LicenseError('format', MSG_FORMAT);
    }
    const pub = keys.get(env.kid);
    if (!pub) throw new LicenseError('key', 'Lizenz ist mit einem unbekannten Schlüssel signiert');
    const msg = kodierung.fromBase64url(env.payload);
    const sig = kodierung.fromBase64url(env.sig);
    const key = await subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    if (!msg || !sig || !(await subtle.verify({ name: 'Ed25519' }, key, sig, msg))) {
      throw new LicenseError('signature', 'Signatur der Lizenz ist ungültig');
    }
    let p;
    try {
      p = decodePayload(decodeText(msg));
    } catch (e) {
      if (e instanceof LicenseError || e instanceof gojson.JsonError) throw new LicenseError('content', MSG_CONTENT);
      throw e;
    }
    validatePayload(p);
    return { kid: env.kid, payload: p, payloadBytes: msg };
  }

  // responseFileName wie license.ResponseFileName.
  function responseFileName(installationId, t) {
    return 'virtualtimer-license-response-' + installationId.slice(0, 8) + '-' + ymd(t) + '.json';
  }

  // ---------- Ausgabeprotokoll ----------

  // ledgerLine wie die Zeile, die licensectl in der Betriebsart test schreibt (ledgerEntry). Es fehlen
  // issuedBy (Konto des Betriebssystems, im Browser unbekannt) und licensectlVersion (kein licensectl).
  // Bei Privatkäufern ohne Referenz (EF-11).
  function ledgerLine(payload, input, kid, req) {
    return gojson.marshal({
      time: payload.issued,
      licenseId: payload.licenseId,
      kid,
      customer: payload.customer,
      installationId: payload.installationId,
      reference: input.isPrivate || req.reference === '' ? undefined : req.reference,
      type: payload.type,
      validUntil: payload.validUntil,
      updatesUntil: payload.updatesUntil,
      seats: payload.seats,
      packages: payload.packages,
      contingent: input.contingent ? input.contingent.id : undefined,
      features: req.features && req.features.size > 0 ? req.features : undefined,
      mode: MODE_TEST,
    });
  }

  // readLedger liest die Zeilen wie readLedger in licensectl (nicht streng, eigene Datei); eine
  // beschädigte Zeile bricht ab, damit nichts an ein beschädigtes Protokoll angehängt wird.
  function readLedger(lines) {
    return lines.map((line, i) => {
      try {
        const v = JSON.parse(line);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('kein Objekt');
        return v;
      } catch (e) {
        throw new LicenseError('ledger', 'Ausgabeprotokoll beschädigt in Zeile ' + (i + 1) + '; keine Lizenz ausgestellt');
      }
    });
  }

  // contingentUse zählt die verschiedenen Installationen eines Kontingents (checkContingent).
  function contingentUse(entries, id) {
    const seen = new Set();
    for (const e of entries) if (e.contingent === id) seen.add(e.installationId);
    return seen;
  }

  function checkContingent(entries, contingent, installationId) {
    if (!contingent) return;
    const seen = contingentUse(entries, contingent.id);
    if (!seen.has(installationId) && seen.size >= contingent.total) {
      throw new LicenseError('contingent_exhausted', 'Kontingent ' + contingent.id + ' erschöpft (' + seen.size + ' von ' + contingent.total + ' Installationen)');
    }
  }

  // issue stellt aus wie issue() in licensectl ohne die Buchung: Betriebsart, Kunde und Laufzeit
  // erneut prüfen, Inhalt bauen, signieren, selbst prüfen. Die Buchung (Kontingent, Protokoll) folgt
  // im Speicher in einem Schritt (speicher.js), erst danach gibt es die Datei.
  // key: { kid, publicRaw (32 Bytes), sign(bytes) → Signatur }.
  async function issue(key, req, input, opts) {
    checkMode(key.kid);
    if (!KID_PATTERN.test(key.kid)) throw new LicenseError('mode', 'Kennung ungültig');
    checkCustomer(input.customer, input.isPrivate);
    if (input.type === TYPE_PERPETUAL && (input.updateMonths < 0 || input.updateMonths > MAX_MONTHS)) {
      throw new LicenseError('updates', 'Update-Zeitraum: 0 bis ' + MAX_MONTHS + ' Monate');
    }
    if (input.type === TYPE_SUBSCRIPTION && (input.months < 1 || input.months > MAX_MONTHS)) {
      throw new LicenseError('months', 'Laufzeit: 1 bis ' + MAX_MONTHS + ' Monate');
    }
    const payload = buildPayload(input, req, opts.now, opts.idBytes);
    const encoded = await encodeLicense(payload, key.kid, key.sign);
    try {
      await verifyLicense(encoded.bytes, new Map([[key.kid, key.publicRaw]]), opts.subtle);
    } catch (e) {
      throw new LicenseError('selfcheck', 'Selbstprüfung der Lizenz: ' + e.message);
    }
    return {
      payload,
      text: encoded.text,
      bytes: encoded.bytes,
      fileName: responseFileName(payload.installationId, payload.issued),
      ledgerLine: ledgerLine(payload, input, key.kid, req),
    };
  }

  return {
    REQUEST_FORMAT,
    LICENSE_FORMAT,
    MAX_FILE_SIZE,
    MAX_SEATS,
    MAX_MONTHS,
    MAX_CUSTOMER,
    PACKAGES,
    PACKAGE_NAMES,
    KID_PATTERN,
    LicenseError,
    trimSpace,
    isTestKid,
    parseTime,
    addMonths,
    parseRequest,
    wishesText,
    typeText,
    packagesText,
    prefill,
    checkForm,
    checkCustomer,
    checkMode,
    buildPayload,
    validatePayload,
    encodeLicense,
    verifyLicense,
    responseFileName,
    ledgerLine,
    readLedger,
    contingentUse,
    checkContingent,
    issue,
  };
});
