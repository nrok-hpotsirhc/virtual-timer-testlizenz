# Testlizenz für Virtual Timer

Web-Werkzeug zum Ausstellen von **Testlizenzen**, bedienbar auf dem Smartphone. Es liest ein License Request File, signiert die Lizenz im Browser mit einem **Testschlüssel** (Kennung `test-…`) und liefert das License Response File zum Herunterladen. Eine statische Seite ohne Server, ohne Fremdbibliotheken und ohne Netzverbindung.

Stand 2026-11-18, Version 0.1.0. Entstanden in Aufgabe 167 des Produkt-Repositorys (Entscheidungen des Auftraggebers vom 2026-11-18).

## Grenzen

- **Nur Testschlüssel.** Das Werkzeug nimmt nur Kennungen mit `test-` an. Testlizenzen gelten nur in Test- und Entwicklungsbuilds von `timerd`; ein Release-Build lässt Testschlüssel fallen (ADR-0012 Nr. 6, AL-10).
- **Produktivlizenzen bleiben offline** am Signierrechner mit `licensectl` (O-4, L-16, ADR-0010). Dieses Werkzeug ist kein Ersatz dafür und gehört nicht in Kundenabläufe.
- Kein Verkauf, keine Zahlung, keine Aufträge (`vt-issue-order/1`): Das macht die Lizenzauswahl.
- Formate und Regeln sind **im Produkt-Repository maßgeblich**. Das Werkzeug baut sie nach; eine Formatänderung beginnt dort mit einem ADR.

## Bedienung auf dem Handy

1. Seite öffnen und im Browsermenü „Zum Home-Bildschirm“ bzw. „App installieren“ wählen.
2. **Testschlüssel anlegen:** „Neu erzeugen“ (empfohlen, der private Schlüssel verlässt das Handy nie) oder „Datei importieren“ (Schlüsseldatei aus `licensectl keygen -kid test-…`). Passphrase mit mindestens 12 Zeichen zweimal eingeben.
3. Den angezeigten **öffentlichen Schlüssel** kopieren (`kid:base64`) und den Testbuild von `timerd` damit bauen, siehe unten.
4. **Lizenz ausstellen:** „License Request File wählen“, Käufer wählen (Firma oder Privatperson, ohne Vorauswahl), Werte prüfen, „Vorschau“, „Signieren“, „License Response File herunterladen“.
5. Das Ausgabeprotokoll gelegentlich als JSONL exportieren.

Nach 5 Minuten ohne Bedienung und beim Verlassen der Seite sperrt sich der Schlüssel; zum Signieren wieder entsperren.

## Testbuild von timerd mit dem Schlüssel

Der öffentliche Schlüssel hat genau das Format von `license.FormatKey` (`kid:base64`):

```sh
# Testbuild mit Oberfläche (Produkt-Repository, tools/release/build-local.sh)
TEST_LICENSE_KEY="test-20261118-1530:…=" sh tools/release/build-local.sh
# oder direkt
go build -ldflags "-X virtualtimer/internal/license.trustedKeysFlag=test-20261118-1530:…=" ./cmd/timerd
# Lizenz prüfen bzw. einspielen
licensectl verify -keys "test-20261118-1530:…=" virtualtimer-license-response-….json
timerd license import virtualtimer-license-response-….json
```

## Was das Werkzeug wie das Produkt macht

| Schritt | Vorbild im Produkt |
|---|---|
| License Request File lesen: höchstens 16 KiB, strenges JSON (exakte Feldnamen, keine doppelten Schlüssel, keine unbekannten Felder, nichts nach dem Wert), `created` in UTC mit `Z`, Installations-ID, Referenz bis 80 Zeichen, Wünsche | `license.ParseRequest`, `license.DecodeStrict` (AL-15, AL-16) |
| Formular vorbelegt mit den Wünschen, Käufer ohne Vorauswahl; Kunde bis 120 Zeichen ohne Steuerzeichen, Kundennummer `K-` bei Privatkäufern (EF-11); Laufzeit 1–120, Updates 0–120, Plätze 1–9999, Pakete, Kontingent `Kennung:Anzahl` | `licensectl serve` (`prefill`, `formInput`), `issue()` |
| Inhalt: gültig ab 24 h vor der Ausstellung (N-5), Laufzeit ab Ausstellung, Felder und Kodierung wie `json.Marshal`, Signatur Ed25519 über genau diese Bytes, Hülle wie `json.MarshalIndent`; Selbstprüfung | `license.Encode`, `license.Verify`, `issue()` |
| Dateiname `virtualtimer-license-response-<8 Zeichen Installations-ID>-<JJJJMMTT>.json` | `license.ResponseFileName` |
| Ausgabeprotokoll als JSON-Zeilen, Kontingent über verschiedene Installationen, erst buchen, dann die Datei; je Vorschau höchstens eine Lizenz | `ledgerEntry`, `checkContingent`, `publish`; Formular-Token in `serve` |
| Schlüsseldatei mit Zeile `licensectl-kid: <kid>` vor dem PEM-Block (PKCS#8 Ed25519) | `readKey`, AL-17 |

Die Gegenprobe zeigt: Mit denselben Werten, derselben Lizenz-ID und demselben Zeitpunkt entsteht **Byte für Byte dieselbe Datei** wie mit `licensectl sign` (Ed25519 ist deterministisch).

**Bewusste Abweichungen:**

- **Schlüsseldateien ohne Kennungszeile werden abgewiesen**, wie in der Betriebsart `test` von `licensectl` (AL-18). Ältere Produktivschlüssel haben keine Zeile; so landet keiner versehentlich unter einer Kennung `test-…` im Browser. Abhilfe für Testschlüssel: neu erzeugen oder die Zeile ergänzen.
- **Ungültiges UTF-8** im License Request File ist ein Fehler. Go ersetzt es still durch U+FFFD; `timerd` schreibt es nie.
- **Ausgabeprotokoll ohne `issuedBy` und `licensectlVersion`:** Der Browser kennt kein Konto des Betriebssystems, und es ist kein `licensectl`. `mode` ist immer `test`. `licensectl` liest die exportierte Datei (geprüft mit einem Kontingent).
- Keine Option `-wie-angefragt`: Das Formular ist wie in `licensectl serve` mit den Wünschen vorbelegt.

## Sicherheitsmodell

**Grundsatz:** GitHub Pages ist statisch; ein „Login“ dort schützte nichts. Deshalb liegt der private Schlüssel **nie auf GitHub** und nie auf einem Server. Signiert wird im Browser.

- **Ablage:** Der Testschlüssel liegt nur in IndexedDB dieses Browsers, verschlüsselt mit AES-256-GCM. Der Schlüssel dazu entsteht aus der Passphrase mit PBKDF2-HMAC-SHA-256 und 600 000 Iterationen, 16 Byte Salz. Die Zahl folgt der Empfehlung der OWASP für PBKDF2-SHA-256 (Password Storage Cheat Sheet, Stand 2023; aus Kenntnis, nicht erneut abgerufen). Gemessen dauert das Entsperren in Chromium etwa 0,2 s und in WebKit 0,3 bis 0,5 s, jeweils auf dem Linux-Rechner der Tests; Handys brauchen länger. Kennung und öffentlicher Schlüssel sind als Zusatzdaten (AAD) an den Geheimtext gebunden.
- **Passphrase:** wird nie gespeichert; die Felder werden nach Gebrauch geleert. Nichts liegt in `localStorage`, `sessionStorage`, Cookies, Adressen oder Protokollausgaben (im Browser-Test geprüft).
- **Im Speicher:** Nach dem Entsperren nur als **nicht exportierbarer** `CryptoKey`. Sperre nach 5 Minuten ohne Bedienung (Wand- und monotone Uhr), beim Verlassen der Seite (`pagehide`) und per Taste.
- **Nur Testschlüssel:** Kennungen ohne `test-` lehnt das Werkzeug beim Import, beim Ablegen, beim Entsperren und beim Signieren ab.
- **Seite:** Content-Security-Policy per `<meta>`: `default-src 'self'`, `connect-src 'none'`, keine Inline-Skripte oder -Stile, `base-uri` und `form-action` `'none'`, Trusted Types. Die Seite kann keine Daten senden; der Browser-Test misst alle Anfragen und versucht Verbindungen, die blockiert werden. Kein Einbetten in fremde Seiten (Prüfung im Skript; `frame-ancestors` wirkt per `<meta>` nicht).
- **Eingaben:** Größen begrenzt (License Request File und Schlüsseldatei 16 KiB, Ausgabeprotokoll 64 MiB, Verschachtelung 64), streng geprüft, Anzeige nur als Text (`textContent`).

**Grenzen des Modells:**

- **Kompromittiertes Handy oder Browser:** Wer Code im Browser ausführen kann, kann während der Entsperrung signieren und die Passphrase mitlesen. Die Verschlüsselung schützt nur die abgelegte Datei.
- **Kompromittiertes GitHub-Konto:** Wer die Seite ändern kann, kann beim nächsten Laden Passphrase und Schlüssel abgreifen. Abhilfe: Seite einmal prüfen, herunterladen und offline nutzen (unten), Prüfsummen getrennt aufbewahren.
- **Gemeinsamer Ursprung:** Alle Pages-Seiten eines GitHub-Kontos teilen sich `https://<konto>.github.io` und damit IndexedDB. Eine andere Seite desselben Kontos könnte den verschlüsselten Datensatz und das Ausgabeprotokoll lesen. Abhilfe: keine weiteren Pages-Seiten im Konto, eine eigene Domain, oder offline nutzen.
- **Datenverlust:** Der Browser kann die Daten bei Platzmangel löschen. Safari löscht nach Angaben von WebKit (2020, nicht erneut geprüft) skriptbare Daten von Websites nach 7 Tagen ohne Nutzung, nicht aber bei Web-Apps auf dem Home-Bildschirm. Testschlüssel sind Wegwerfschlüssel; das Ausgabeprotokoll regelmäßig exportieren.
- **Speicher von JavaScript:** Texte lassen sich nicht sicher löschen. Beim Anlegen oder Importieren liegt der Schlüssel kurz im Speicher der Seite, ebenso die Passphrase bis zur Speicherbereinigung. Bytefelder werden überschrieben.
- **Uhr:** Ausstellung und Laufzeit folgen der Uhr des Geräts; die Vorschau zeigt sie.
- Keine Zusage absoluter Sicherheit. Das Werkzeug ist für Testlizenzen gemacht; deren Missbrauch wirkt nur in Testbuilds.

## Browser-Unterstützung

Nötig sind WebCrypto mit Ed25519, PBKDF2 und AES-GCM sowie IndexedDB in einer sicheren Umgebung (https oder Datei).

| Browser | Stand | Nachweis |
|---|---|---|
| Chromium 153 (Playwright, Linux), über http und von `file://` | geht | Browser-Test |
| WebKit 26.6 (Playwright, Linux; Engine von Safari) | geht | Browser-Test |
| Safari auf iPhone/iPad, Chrome auf Android | erwartet ab Safari 17, Chrome 137 (Ed25519 in WebCrypto, aus Kenntnis) | **nicht geprüft**: kein echtes Gerät |
| Firefox (ab 129 erwartet) | nicht geprüft | Firefox ist hier nicht installiert |

Ohne Ed25519 meldet die Seite das beim Start und bleibt gesperrt.

## Technik

- Dateien der Seite: `index.html`, `app.css`, `manifest.webmanifest`, `js/*.js`, `icons/*`. Kein Build-Schritt, keine Abhängigkeit.
- **Klassische Skripte statt ES-Module:** Chromium 153 und WebKit 26.6 laden Module von `file://` nicht (CORS, Ursprung `null`; gemessen 2026-11-18). Damit die heruntergeladene Seite offline läuft, sind die Dateien klassische Skripte mit `defer` und einer UMD-Hülle: im Browser unter `window.VTL`, in Node per `require` für die Tests.
- Kein Service Worker: Signieren und Ablage brauchen kein Netz; offline läuft die heruntergeladene Seite. Ein Service Worker brächte einen zweiten Aktualisierungsweg, aber keinen Schutz.
- Manifest und Symbole für die Installation als Web-App; `tools/symbole.mjs` erzeugt die PNG-Symbole aus `icons/symbol.svg`.
- Gestaltung nach den Tokens des Designsystems des Produkts (`web/src/app.css`): helles und dunkles Schema wie das System, Zielgrößen ab 44 px, Fokusring 3 px, Kontraste nach WCAG AA (Test).

## Prüfungen

| Befehl | Inhalt |
|---|---|
| `node --test` | Unit-Tests: strenges JSON und Ausgabe wie Go, License Request File (Grenzfälle aus Läufen von `license.ParseRequest`), Eingaben, Inhalt und Signatur, Ausgabeprotokoll, Kontingent, Schlüsseldatei, Verschlüsselung, CSP und Seite, Kontraste |
| `node tools/mutationsproben.mjs` | baut bekannte Fehler in eine Kopie ein (z. B. Kennung ohne `test-`, Signatur über falsche Bytes, Feld in anderer Schreibweise, falsche Passphrase entsperrt) und erwartet rote Tests |
| `sh tools/gegenprobe.sh` | baut `licensectl` und `timerd` aus dem Produkt (`git archive`, Toolchain aus `go.mod`) und prüft: Import einer `keygen`-Datei, `licensectl verify`, `timerd license import`, Bytegleichheit mit `licensectl sign`, Grenzfälle im Vergleich, Testvektoren, Ausgabeprotokoll in `licensectl`; danach den Browser-Test |
| `node tests/browser.mjs` | Browser-Test bei 390 px in Chromium (auch `file://`) und WebKit mit dem vorinstallierten Playwright; Aufruf mit Umgebung über die Gegenprobe |

Die Gegenprobe braucht ein Produkt-Repository daneben (`PRODUKT_REPO`, Standard `../virtual-timer-projektstruktur-v3`) mit `origin/main` (`PRODUKT_REF`) sowie Go mit Zugriff auf die Toolchain aus `go.mod`. Arbeitsdateien entstehen außerhalb der Repositories und werden gelöscht.

## Einrichtung von GitHub Pages

1. Repository → Settings → Pages → „Deploy from a branch“, Branch `main`, Ordner `/ (root)`.
2. `_config.yml` schließt `README.md`, `CLAUDE.md`, `docs/`, `tests/` und `tools/` von der Veröffentlichung aus (Jekyll von GitHub Pages). Nur die Dateien der Seite sind öffentlich. Nicht `.nojekyll` anlegen, sonst wird alles veröffentlicht.
3. Nach der Einrichtung prüfen: Die Seite lädt; `…/README.md` und `…/tools/gegenprobe.sh` liefern 404; die Prüfsumme von `index.html` gleicht der im Repository.

Nach Kenntnis (nicht abgerufen, vor der Einrichtung in der Dokumentation von GitHub prüfen): Pages aus einem privaten Repository braucht einen bezahlten Plan, und die Seite ist trotzdem öffentlich erreichbar, außer mit privaten Pages in GitHub Enterprise Cloud. Die Seite enthält keine Geheimnisse; der Schutz liegt im Browser (siehe Sicherheitsmodell).

## Offline nutzen und Prüfsumme

```sh
git clone <repository> testlizenz && cd testlizenz && git checkout <geprüfter Commit>
sha256sum index.html app.css manifest.webmanifest js/*.js icons/* > ~/testlizenz.sha256   # einmal, getrennt aufbewahren
sha256sum -c ~/testlizenz.sha256                                                        # vor jeder Nutzung
```

Dann `index.html` im Browser öffnen (`file://`). Eine Datei-Kopie hat einen eigenen Speicher; ein Schlüssel aus der Pages-Seite ist dort nicht vorhanden. Auf Handys ist das Öffnen lokaler Seiten je nach System eingeschränkt.

## Lizenz

Keine. Privates Werkzeug, alle Rechte vorbehalten. Es gibt deshalb keine Datei `LICENSE`.

Weitere Repositories des Projekts: [`docs/repositories.md`](docs/repositories.md).
