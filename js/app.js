/* Steuerung der Seite. Nur DOM-Methoden und textContent (Trusted Types, CSP), keine Netzwerkzugriffe.
   Ablauf: Testschlüssel anlegen oder entsperren → License Request File lesen → Werte → Vorschau →
   signieren, buchen, herunterladen. */
(function () {
  'use strict';

  const VERSION = '0.1.0';
  const IDLE_MS = 5 * 60 * 1000; // automatisch sperren nach 5 Minuten ohne Bedienung
  const { kodierung, lizenz, schluessel, speicher } = window.VTL;

  const $ = (id) => document.getElementById(id);
  const state = {
    record: null, // abgelegter, verschlüsselter Schlüssel
    brokenRecord: false, // abgelegter Datensatz unlesbar (ersetzbar durch einen neuen Schlüssel)
    key: null, // entsperrt: { kid, publicRaw, privateKey (nicht exportierbar), sign }
    request: null, // { req }
    input: null, // geprüfte Werte der Vorschau
    issued: null, // ausgestellte Lizenz zu dieser Vorschau (einmal je Vorschau)
    busy: false,
  };

  // ---------- Hilfen ----------

  function say(text) {
    $('ansage').textContent = '';
    window.setTimeout(() => {
      $('ansage').textContent = text;
    }, 50);
  }

  function setError(id, err) {
    $(id).textContent = err ? (err.message || String(err)) : '';
  }

  function show(id, visible) {
    $(id).hidden = !visible;
  }

  function utcText(d) {
    const iso = d.toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
  }

  function dateText(d) {
    return d ? d.toISOString().slice(0, 10) : 'unbefristet';
  }

  function facts(dl, rows) {
    dl.replaceChildren();
    for (const [term, value, asCode] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      if (asCode) {
        const c = document.createElement('code');
        c.textContent = value;
        dd.append(c);
      } else {
        dd.textContent = value;
      }
      dl.append(dt, dd);
    }
  }

  async function busy(button, fn) {
    if (state.busy) return;
    state.busy = true;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    try {
      await fn();
    } finally {
      state.busy = false;
      button.removeAttribute('aria-busy');
      button.disabled = false;
      render();
    }
  }

  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function readFile(input, limit) {
    const file = input.files && input.files[0];
    if (!file) return null;
    if (file.size > limit) throw new Error('Datei zu groß (höchstens ' + (limit >> 10) + ' KiB)');
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  }

  // ---------- Zustand anzeigen ----------

  function render() {
    const chip = $('zustand');
    if (!state.record) {
      chip.textContent = 'Kein Schlüssel';
      chip.dataset.tone = 'warn';
    } else if (state.key) {
      chip.textContent = 'Entsperrt';
      chip.dataset.tone = 'ok';
    } else {
      chip.textContent = 'Gesperrt';
      delete chip.dataset.tone;
    }
    show('f-neu', !state.record);
    show('schluessel-da', Boolean(state.record));
    if (state.record) {
      $('kid').textContent = state.record.kid;
      $('abgelegt').textContent = utcText(new Date(state.record.created));
      $('oeffentlich').textContent = schluessel.formatKey(state.record.kid, kodierung.fromBase64(state.record.publicKey));
      show('f-entsperren', !state.key);
      show('entsperrt', Boolean(state.key));
    }
    const importing = document.querySelector('input[name="quelle"]:checked').value === 'import';
    show('feld-schluesseldatei', importing);
    $('b-anlegen').textContent = importing ? 'Schlüssel importieren' : 'Schlüssel erzeugen';

    const locked = !state.key;
    const note = !state.record ? 'Zum Signieren zuerst einen Testschlüssel anlegen (Schritt 1).' :
      locked ? 'Zum Signieren den Testschlüssel entsperren (Schritt 1).' : '';
    $('vorschau-gesperrt').textContent = note;
    show('vorschau-gesperrt', note !== '' && !state.issued);
    $('b-signieren').disabled = state.busy || (locked && !state.issued);
  }

  function step(name) {
    show('s-anfrage', name === 'anfrage');
    show('f-werte', name === 'werte');
    show('s-vorschau', name === 'vorschau');
    show('s-fertig', name === 'fertig');
  }

  // ---------- Schlüssel ----------

  function lock(reason) {
    if (!state.key) return;
    state.key = null; // der CryptoKey hat keine weitere Referenz
    for (const id of ['pp', 'pp-neu', 'pp-neu2']) $(id).value = '';
    render();
    say('Schlüssel gesperrt' + (reason ? ' (' + reason + ')' : ''));
  }

  async function loadRecord() {
    const record = await speicher.getKey();
    state.record = null;
    state.brokenRecord = false;
    if (record) {
      try {
        schluessel.checkRecord(record);
        state.record = record;
      } catch (err) {
        // Nicht still löschen: Hinweis zeigen; erst ein neuer Schlüssel ersetzt den Datensatz.
        state.brokenRecord = true;
        $('f-neu-fehler').textContent = err.message + '. Ein neuer Schlüssel ersetzt ihn.';
      }
    }
    $('dauerhaft').textContent = (await speicher.persisted()) ? 'dauerhaft (vom Browser bestätigt)' : 'kann der Browser bei Platzmangel löschen';
  }

  async function createKey(event) {
    event.preventDefault();
    setError('f-neu-fehler', null);
    await busy($('b-anlegen'), async () => {
      try {
        const pp1 = $('pp-neu').value;
        if (pp1 !== $('pp-neu2').value) throw new Error('Die Passphrasen stimmen nicht überein');
        schluessel.checkPassphrase(pp1);
        let material;
        if (document.querySelector('input[name="quelle"]:checked').value === 'import') {
          const f = await readFile($('schluesseldatei'), 16 << 10);
          if (!f) throw new Error('Schlüsseldatei wählen');
          let text;
          try {
            text = kodierung.fromUtf8(f.bytes);
          } finally {
            f.bytes.fill(0);
          }
          material = await schluessel.fromKeyFile(text);
          $('schluesseldatei').value = '';
          $('schluesseldatei-name').textContent = '';
        } else {
          material = await schluessel.generate(new Date());
        }
        let record;
        try {
          record = await schluessel.seal(material, pp1, new Date());
        } finally {
          material.pkcs8.fill(0);
        }
        if (state.brokenRecord) await speicher.deleteKey();
        await speicher.addKey(record);
        await speicher.persist();
        state.key = await schluessel.unlock(record, pp1);
        $('pp-neu').value = '';
        $('pp-neu2').value = '';
        await loadRecord();
        say('Testschlüssel ' + record.kid + ' angelegt und entsperrt');
      } catch (err) {
        setError('f-neu-fehler', err);
      }
    });
  }

  async function unlockKey(event) {
    event.preventDefault();
    setError('f-entsperren-fehler', null);
    await busy($('b-entsperren'), async () => {
      try {
        state.key = await schluessel.unlock(state.record, $('pp').value);
        say('Schlüssel entsperrt');
      } catch (err) {
        setError('f-entsperren-fehler', err);
      } finally {
        $('pp').value = '';
      }
    });
  }

  async function copyKey() {
    const text = $('oeffentlich').textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('kopiert').textContent = 'Kopiert.';
    } catch (e) {
      window.getSelection().selectAllChildren($('oeffentlich'));
      $('kopiert').textContent = 'Markiert; bitte über das Menü kopieren.';
    }
  }

  async function deleteKey() {
    await speicher.deleteKey();
    state.key = null;
    state.record = null;
    show('loeschen-frage', false);
    $('b-loeschen').setAttribute('aria-expanded', 'false');
    render();
    say('Schlüssel gelöscht');
  }

  // ---------- Ausstellen ----------

  async function readRequest() {
    setError('anfrage-fehler', null);
    try {
      const f = await readFile($('anfrage'), lizenz.MAX_FILE_SIZE);
      if (!f) return;
      const req = lizenz.parseRequest(f.bytes);
      state.request = { req };
      state.input = null;
      state.issued = null;
      fillForm(req);
      step('werte');
      $('t-ausstellen').focus();
      say('License Request File gelesen');
    } catch (err) {
      setError('anfrage-fehler', err instanceof lizenz.LicenseError ? 'License Request File: ' + err.message : err);
    } finally {
      $('anfrage').value = '';
    }
  }

  function fillForm(req) {
    facts($('anfrage-fakten'), [
      ['Installation', req.installationId, true],
      ['Referenz', req.reference || '–'],
      ['Version', req.version || '–'],
      ['Erstellt', req.created ? utcText(req.created.date) : '–'],
      ['Rechnermerkmale', String(req.features ? req.features.size : 0)],
      ['Wünsche des Kunden', lizenz.wishesText(req.wishes)],
    ]);
    $('wunsch-hinweis').textContent = req.wishes ?
      'Das Formular ist mit den Wünschen vorbelegt. Bitte mit dem Auftrag abgleichen; ausgestellt wird, was hier steht.' :
      'Das License Request File enthält keine Wünsche; die Werte bitte nach dem Auftrag eintragen.';
    const v = lizenz.prefill(req);
    for (const r of document.querySelectorAll('input[name="kaeufer"]')) r.checked = false; // Pflichtwahl ohne Vorauswahl (EF-11)
    $('kunde').value = v.customer;
    for (const r of document.querySelectorAll('input[name="art"]')) r.checked = r.value === v.type;
    $('monate').value = v.months;
    $('updates').value = v.updates;
    $('plaetze').value = v.seats;
    for (const c of document.querySelectorAll('input[name="pakete"]')) c.checked = v.packages.includes(c.value);
    $('kontingent').value = v.contingent;
    setError('werte-fehler', null);
    toggleType();
  }

  function toggleType() {
    const sel = document.querySelector('input[name="art"]:checked');
    const perpetual = sel && sel.value === 'perpetual';
    show('feld-monate', !perpetual);
    show('feld-updates', perpetual);
  }

  function formValues() {
    const checked = (name) => {
      const el = document.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : '';
    };
    return {
      buyer: checked('kaeufer'),
      customer: $('kunde').value,
      type: checked('art'),
      months: $('monate').value,
      updates: $('updates').value,
      seats: $('plaetze').value,
      // Reihenfolge wie im Formular von licensectl serve: trp, dann mtdoe
      packages: Array.from(document.querySelectorAll('input[name="pakete"]:checked'), (c) => c.value),
      contingent: $('kontingent').value,
    };
  }

  async function preview(event) {
    event.preventDefault();
    setError('werte-fehler', null);
    setError('vorschau-fehler', null);
    try {
      const input = lizenz.checkForm(formValues());
      const req = state.request.req;
      const lines = await speicher.ledgerLines();
      const entries = lizenz.readLedger(lines);
      const now = new Date();
      const rows = [
        ['Kunde', (input.isPrivate ? 'Privatperson, Kundennummer ' : 'Firma ') + input.customer],
        ['Installation', req.installationId, true],
        ['Art', lizenz.typeText(input.type, input.months)],
        ['Gültig bis', input.type === 'subscription' ? 'etwa ' + dateText(lizenz.addMonths(now, input.months)) : 'unbefristet'],
      ];
      if (input.type === 'perpetual') {
        rows.push(['Updates bis', input.updateMonths > 0 ? 'etwa ' + dateText(lizenz.addMonths(now, input.updateMonths)) : 'ohne Ende']);
      }
      rows.push(['Bedienplätze', String(input.seats)], ['Pakete', lizenz.packagesText(input.packages)]);
      if (input.contingent) {
        const used = lizenz.contingentUse(entries, input.contingent.id);
        rows.push(['Kontingent', input.contingent.id + ': ' + used.size + ' von ' + input.contingent.total + ' belegt' +
          (used.has(req.installationId) ? ', diese Installation ist schon gezählt' : '')]);
        lizenz.checkContingent(entries, input.contingent, req.installationId);
      }
      const before = entries.filter((e) => e.installationId === req.installationId).length;
      rows.push(['Bisher für diese Installation', before === 0 ? 'keine Lizenz' : before + (before === 1 ? ' Lizenz' : ' Lizenzen')]);
      rows.push(['Schlüssel', state.record ? state.record.kid : '–', true], ['Uhr dieses Geräts', utcText(now)]);
      facts($('vorschau-fakten'), rows);
      state.input = input;
      state.issued = null;
      step('vorschau');
      render();
      $('t-vorschau').focus();
    } catch (err) {
      setError('werte-fehler', err);
    }
  }

  async function sign() {
    setError('vorschau-fehler', null);
    if (state.issued) {
      showIssued(); // erneut ausgelöst: dieselbe Lizenz, keine zweite Buchung
      return;
    }
    await busy($('b-signieren'), async () => {
      try {
        if (!state.key) throw new Error('Schlüssel ist gesperrt');
        const req = state.request.req;
        const input = state.input;
        const result = await lizenz.issue(state.key, req, input, {
          now: new Date(),
          idBytes: crypto.getRandomValues(new Uint8Array(8)),
          subtle: crypto.subtle,
        });
        // Erst buchen (Kontingent unter derselben Transaktion), dann die Datei anbieten.
        await speicher.book(result.ledgerLine, (lines) => {
          lizenz.checkContingent(lizenz.readLedger(lines), input.contingent, req.installationId);
        });
        state.issued = result;
        await renderLedger();
        showIssued();
        say('Lizenz ' + result.payload.licenseId + ' ausgestellt');
      } catch (err) {
        setError('vorschau-fehler', 'Nicht ausgestellt: ' + (err.message || err));
      }
    });
  }

  function showIssued() {
    const r = state.issued;
    const p = r.payload;
    $('fertig-titel').textContent = 'Lizenz ' + p.licenseId + ' ausgestellt und im Ausgabeprotokoll gebucht.';
    facts($('fertig-fakten'), [
      ['Kunde', p.customer],
      ['Art', lizenz.typeText(p.type, state.input.months) + ', gültig bis ' + dateText(p.validUntil)],
      ['Bedienplätze', String(p.seats)],
      ['Pakete', lizenz.packagesText(p.packages)],
      ['Datei', r.fileName, true],
    ]);
    step('fertig');
    $('fertig-titel').focus();
  }

  function resetIssue() {
    state.request = null;
    state.input = null;
    state.issued = null;
    step('anfrage');
    render();
    $('t-ausstellen').focus();
  }

  // ---------- Ausgabeprotokoll ----------

  async function renderLedger() {
    setError('protokoll-fehler', null);
    const list = $('protokoll-liste');
    list.replaceChildren();
    let lines = [];
    try {
      lines = await speicher.ledgerLines();
      const entries = lizenz.readLedger(lines);
      for (const e of entries.slice(-5).reverse()) {
        const li = document.createElement('li');
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = String(e.time).slice(0, 16).replace('T', ' ') + ' UTC · ';
        const id = document.createElement('code');
        id.textContent = String(e.licenseId);
        li.append(when, id, document.createTextNode(' · ' + e.customer + ' · ' + String(e.installationId).slice(0, 8) + '…'));
        list.append(li);
      }
    } catch (err) {
      setError('protokoll-fehler', err);
    }
    $('protokoll-anzahl').textContent = lines.length === 0 ? 'Noch keine Lizenz ausgestellt.' :
      lines.length + (lines.length === 1 ? ' Eintrag' : ' Einträge') + (lines.length > 5 ? ', die letzten fünf:' : ':');
    $('b-export').disabled = lines.length === 0;
  }

  async function exportLedger() {
    const lines = await speicher.ledgerLines();
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    download('ausgabeprotokoll-testlizenz-' + day + '.jsonl', kodierung.utf8(lines.map((l) => l + '\n').join('')), 'application/octet-stream');
  }

  // ---------- Sperre nach Inaktivität und beim Verlassen ----------

  let lastWall = Date.now();
  let lastMono = performance.now();
  function activity() {
    lastWall = Date.now();
    lastMono = performance.now();
  }
  function checkIdle() {
    // Wanduhr und monotone Uhr: Ein Stellen der Uhr verlängert die Frist nicht.
    if (state.key && (Date.now() - lastWall >= IDLE_MS || performance.now() - lastMono >= IDLE_MS)) lock('nach 5 Minuten ohne Bedienung');
  }

  // ---------- Start ----------

  async function supported() {
    if (window.top !== window.self) throw new Error('Das Werkzeug läuft nicht in einem Rahmen einer anderen Seite.');
    if (!window.isSecureContext || !window.crypto || !crypto.subtle) throw new Error('Dieser Browser bietet hier kein WebCrypto (sichere Umgebung nötig: https oder Datei).');
    try {
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    } catch (e) {
      throw new Error('Dieser Browser kann kein Ed25519 in WebCrypto. Nötig sind z. B. Chrome ab 137, Safari ab 17 oder Firefox ab 129.');
    }
    if (!window.indexedDB) throw new Error('Dieser Browser bietet hier keinen Speicher (IndexedDB), z. B. im privaten Modus.');
  }

  async function start() {
    $('version').textContent = VERSION;
    try {
      await supported();
      await loadRecord();
    } catch (err) {
      $('nicht-bereit').textContent = err.message || String(err);
      show('nicht-bereit', true);
      $('zustand').textContent = 'Nicht bereit';
      $('zustand').dataset.tone = 'danger';
      for (const el of document.querySelectorAll('main button, main input')) el.disabled = true;
      return;
    }
    $('f-neu').addEventListener('submit', createKey);
    for (const r of document.querySelectorAll('input[name="quelle"]')) r.addEventListener('change', render);
    $('schluesseldatei').addEventListener('change', () => {
      const f = $('schluesseldatei').files[0];
      $('schluesseldatei-name').textContent = f ? 'Gewählt: ' + f.name : '';
    });
    $('f-entsperren').addEventListener('submit', unlockKey);
    $('b-sperren').addEventListener('click', () => lock(''));
    $('b-kopieren').addEventListener('click', copyKey);
    $('b-loeschen').addEventListener('click', () => {
      const open = $('loeschen-frage').hidden;
      show('loeschen-frage', open);
      $('b-loeschen').setAttribute('aria-expanded', String(open));
    });
    $('b-loeschen-nein').addEventListener('click', () => {
      show('loeschen-frage', false);
      $('b-loeschen').setAttribute('aria-expanded', 'false');
      $('b-loeschen').focus();
    });
    $('b-loeschen-ja').addEventListener('click', () => deleteKey().catch((err) => setError('f-entsperren-fehler', err)));
    $('anfrage').addEventListener('change', readRequest);
    for (const r of document.querySelectorAll('input[name="art"]')) r.addEventListener('change', toggleType);
    $('f-werte').addEventListener('submit', preview);
    $('b-andere').addEventListener('click', resetIssue);
    $('b-aendern').addEventListener('click', () => {
      state.input = null;
      step('werte');
      $('t-ausstellen').focus();
    });
    $('b-signieren').addEventListener('click', sign);
    $('b-herunterladen').addEventListener('click', () => download(state.issued.fileName, state.issued.bytes, 'application/json'));
    $('b-naechste').addEventListener('click', resetIssue);
    $('b-export').addEventListener('click', () => exportLedger().catch((err) => setError('protokoll-fehler', err)));

    for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
      window.addEventListener(type, activity, { capture: true, passive: true });
    }
    window.setInterval(checkIdle, 5000);
    document.addEventListener('visibilitychange', checkIdle);
    window.addEventListener('pagehide', () => lock('Seite verlassen'));

    step('anfrage');
    render();
    await renderLedger();
  }

  start();
})();
