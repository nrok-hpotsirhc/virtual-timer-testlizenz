# Repositories des Projekts (intern)

Stand 2026-11-18. Gegenstück zu `docs/repositories.md` im Produkt-Repository; bei Widerspruch gilt das Produkt-Repository. Das Repository ist öffentlich; diese Datei steht nicht auf der Pages-Seite (`_config.yml`).

| Repository | Inhalt | Verweis zurück |
|---|---|---|
| [`virtual-timer-projektstruktur-v3`](https://github.com/nrok-hpotsirhc/virtual-timer-projektstruktur-v3) | Produkt **Virtual Timer**: `timerd`, Lizenzserver `licensectl` am Signierrechner, Formate, ADRs, Entscheidungsregister | `docs/repositories.md` dort |
| [`virtual-timer-licenseselector`](https://github.com/nrok-hpotsirhc/virtual-timer-licenseselector) | Verkaufsservice **„Lizenzauswahl“** nach ADR-0010: Bestellung, Zahlung, Rechnung, Ausstellungsweg | `docs/repositories.md` dort |
| [`module.bitfocus.plura.tcu`](https://github.com/nrok-hpotsirhc/module.bitfocus.plura.tcu) | Bitfocus-Companion-Modul (TRP-Client), E2E-Testclient des Produkts | `docs/related-repositories.md` dort |
| `virtual-timer-testlizenz` (dieses) | Web-Werkzeug für **Testlizenzen** (nur `test-…`), statisch über GitHub Pages, Signatur im Browser (Aufgabe 167) | diese Datei |

## Schnittstellen dieses Werkzeugs

| Richtung | Schnittstelle | Maßgeblich |
|---|---|---|
| `timerd` → Werkzeug | License Request File `timerd-license-request/1` (Datei) | Produkt: `internal/license/license.go` (`ParseRequest`), ADR-0004 V2 |
| Werkzeug → `timerd` | License Response File `timerd-license/1` (Datei), nur mit Testschlüssel | Produkt: `license.Encode`, `license.Verify`, ADR-0012 AL-15, AL-16 |
| `licensectl keygen` → Werkzeug | Schlüsseldatei mit Zeile `licensectl-kid: test-…` (optional; empfohlen ist ein im Browser erzeugter Schlüssel) | Produkt: `cmd/licensectl` (`readKey`), AL-17, AL-18 |
| Werkzeug → Testbuild | öffentlicher Schlüssel `kid:base64` für `TEST_LICENSE_KEY` bzw. `trustedKeysFlag` | Produkt: `license.FormatKey`, `tools/release/build-local.sh` |

Zur Lizenzauswahl und zum Signierrechner gibt es **keine Verbindung**. Das Werkzeug ersetzt keinen Ausstellungsweg für Kunden.

## Regeln über Repository-Grenzen

- **Formate:** Das Produkt-Repository ist maßgeblich; dieses Werkzeug baut nach und prüft mit `tools/gegenprobe.sh` gegen `licensectl` und `timerd` eines festen Commits. Eine Formatänderung beginnt mit einem ADR im Produkt-Repository.
- **Keine vertraulichen Inhalte aus dem Produkt-Repository:** keine MTDoE-Inhalte, nichts aus `.local/sources/`.
- **Schlüssel:** Kein privater Schlüssel liegt in einem Repository. Produktivschlüssel nie in dieses Werkzeug.
