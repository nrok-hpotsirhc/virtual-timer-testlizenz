# CLAUDE.md – Testlizenz

## 1. Produkt und Umfang
Web-Werkzeug zum Ausstellen von **Testlizenzen** für Virtual Timer, bedienbar auf dem Smartphone, als statische Seite über GitHub Pages (Aufgabe 167, Entscheidungen des Auftraggebers vom 2026-11-18). Übersicht aller Repositories: `docs/repositories.md`.
- Maßgeblich ist das Produkt-Repository `nrok-hpotsirhc/virtual-timer-projektstruktur-v3` mit seinen Entscheidungen (`docs/entscheidungen.md`), ADR-0004, ADR-0010 und ADR-0012. Bei Widerspruch gilt das Produkt-Repository.
- **Nur Testschlüssel** (Kennung `test-…`). Produktivlizenzen bleiben offline bei `licensectl` am Signierrechner (L-16, O-4, ADR-0010). Keine Funktion, die Produktivschlüssel annimmt; Schlüsseldateien ohne Kennungszeile abweisen (AL-18).
- Kleinste vollständige Umsetzung, keine spekulativen Funktionen.

## 2. Technik und Sicherheit
- Statische Seite: HTML, CSS, klassische Skripte (Begründung im README, Abschnitt „Technik“). **Keine Fremdbibliotheken, kein Build-Schritt, keine externen Anfragen.** CSP per `<meta>` mit `connect-src 'none'`, keine Inline-Skripte oder -Stile; DOM nur über `textContent` und DOM-Methoden.
- **Der private Schlüssel liegt nie auf GitHub oder einem Server.** Signiert wird im Browser. Ablage nur verschlüsselt in IndexedDB (PBKDF2-SHA-256 ≥ 600 000, AES-GCM), nach dem Entsperren nur als nicht exportierbarer `CryptoKey`. Die Passphrase wird nie gespeichert. Nichts in Web Storage, Cookies, Adressen oder Protokollausgaben.
- **Formate maßgeblich im Produkt:** License Request File, Lizenz `timerd-license/1`, Ausgabeprotokoll und Schlüsseldatei werden nachgebaut, nie hier geändert. Eine Änderung braucht zuerst ein ADR im Produkt-Repository. Abweichungen im README begründen.
- Keine MTDoE-Inhalte und nichts aus `.local/sources/` des Produkt-Repositorys. `mtdoe` erscheint nur als Paketkennung, angezeigt als „Anzeigen-Master“.
- Jede neue Funktion mit Angriffsfläche vorher prüfen (Sicherheitsmodell im README nachführen).

## 3. Tests und Definition of Done
- `node --test` (Node 22, ohne Abhängigkeiten), `node tools/mutationsproben.mjs`, `sh tools/gegenprobe.sh` (baut `licensectl` und `timerd` aus dem Produkt per `git archive`, ändert dort nichts) mit Browser-Test (`tests/browser.mjs`, vorinstalliertes Playwright, nichts installieren).
- Jede Regel mit Unit-Test; Formatänderungen im Produkt hier mit der Gegenprobe nachweisen. Fehlerkorrekturen brauchen Regressionstests.
- **Keine privaten Schlüssel, Passphrasen oder Lizenzen im Repository.** Testdaten nur zur Laufzeit erzeugen. Keine Personennamen; Kunde in Tests z. B. „Hardwaretest“.
- passed, failed, blocked und not_run unterscheiden; nicht ausgeführte Tests und fehlende Werkzeuge (z. B. echte Geräte, Firefox) offenlegen. Keine bestandenen Tests ohne Ausführung behaupten.
- Substanzielle Änderungen brauchen einen unabhängigen Review durch Menschen; KI-Reviews sind Befunde, keine Abnahme.

## 4. Arbeitsweise
- **Sprache:** Deutsch für Oberfläche, Doku, Commits und Antworten; Bezeichner im Code englisch wie im Produkt.
- **Git:** Commits nur auf Branches `claude/…`, Pull Requests gegen `main`. Merges, Tags, Einrichtung von Pages, Kosten und Konten nur mit Auftrag des Auftraggebers. Kein Force-Push.
- **Rückfragen:** nur bei Design- und Anforderungsfragen; sonst selbstständig arbeiten und Entscheidungen begründet dokumentieren. Zwischen größeren Schritten anhalten und melden.
- **Belege:** Keine erfundenen APIs, Felder, Quellen oder Ergebnisse. Fakten, Annahmen und Vorschläge trennen; externe Angaben mit Quelle und Abrufdatum, sonst als nicht geprüft kennzeichnen.
- **Personennamen:** keine im Repository, nur Firmennamen.
