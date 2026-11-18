/* Ablage im Browser (IndexedDB), nur im Browser genutzt:
   - „schluessel“: genau ein verschlüsselter Testschlüssel (Datensatz aus schluessel.seal);
   - „protokoll“: das Ausgabeprotokoll als JSON-Zeilen in Buchungsreihenfolge.
   Keine Passphrase, kein Klartextschlüssel, kein Web Storage. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.VTL = root.VTL || {}).speicher = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const DB_NAME = 'vt-testlizenz';
  const KEYS = 'schluessel';
  const LEDGER = 'protokoll';
  const ACTIVE = 'aktiv';
  const MAX_LEDGER_BYTES = 64 << 20; // wie maxLedger in licensectl (ADR-0005 V4)

  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore(KEYS);
          db.createObjectStore(LEDGER, { autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Speicher blockiert (Seite in einem anderen Tab offen?)'));
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  // run führt fn in einer Transaktion aus; das Ergebnis gilt erst nach dem Abschluss (oncomplete).
  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      let failure = null;
      tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
      tx.onerror = () => reject(failure || tx.error);
      tx.onabort = () => reject(failure || tx.error || new Error('Transaktion abgebrochen'));
      try {
        fn(tx, (v) => {
          result = v;
        }, (err) => {
          failure = err;
          tx.abort();
        });
      } catch (err) {
        failure = err;
        tx.abort();
      }
    });
  }

  function getKey() {
    return run([KEYS], 'readonly', (tx, done) => {
      const r = tx.objectStore(KEYS).get(ACTIVE);
      r.onsuccess = () => done(r.result);
    });
  }

  // addKey legt den Schlüssel nur an, wenn noch keiner da ist (nie überschreiben).
  function addKey(record) {
    return run([KEYS], 'readwrite', (tx) => {
      tx.objectStore(KEYS).add(record, ACTIVE);
    });
  }

  function deleteKey() {
    return run([KEYS], 'readwrite', (tx) => {
      tx.objectStore(KEYS).delete(ACTIVE);
    });
  }

  function ledgerLines() {
    return run([LEDGER], 'readonly', (tx, done) => {
      const r = tx.objectStore(LEDGER).getAll();
      r.onsuccess = () => done(r.result);
    });
  }

  // book bucht eine Zeile in einer Transaktion: alle Zeilen lesen, check(zeilen) prüfen (wirft bei
  // erschöpftem Kontingent oder beschädigtem Protokoll), dann anhängen. IndexedDB führt
  // Schreibtransaktionen auf demselben Speicher nacheinander aus; zwei Tabs buchen so nicht
  // denselben letzten Platz eines Kontingents.
  function book(line, check) {
    return run([LEDGER], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore(LEDGER);
      const r = store.getAll();
      r.onsuccess = () => {
        try {
          const lines = r.result;
          const size = lines.reduce((n, l) => n + l.length + 1, 0);
          if (size + line.length + 1 > MAX_LEDGER_BYTES) throw new Error('Ausgabeprotokoll größer als 64 MiB; bitte exportieren und Werkzeug neu einrichten');
          check(lines);
          store.add(line);
          done(lines.length + 1);
        } catch (err) {
          fail(err);
        }
      };
    });
  }

  async function persist() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch (e) {
      // ohne Ergebnis: Der Browser kann die Daten bei Platzmangel löschen.
    }
    return false;
  }

  async function persisted() {
    try {
      if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted();
    } catch (e) {
      // wie persist
    }
    return false;
  }

  return { DB_NAME, getKey, addKey, deleteKey, ledgerLines, book, persist, persisted };
});
