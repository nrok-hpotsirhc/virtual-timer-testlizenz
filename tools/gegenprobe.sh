#!/bin/sh
# Gegenprobe mit dem echten Produkt: baut licensectl und timerd aus dem Produkt-Repository und prüft
# das Werkzeug dagegen (tools/gegenprobe.mjs), danach den Browser-Test (tests/browser.mjs).
#
# Das Produkt wird nur gelesen: git archive des Commits in ein Arbeitsverzeichnis außerhalb beider
# Repositories, dort bauen. Netz nur für den Go-Modul-Proxy, falls die Toolchain aus go.mod (Zeile
# toolchain) noch nicht im Modul-Cache liegt. Keine Schlüssel, Lizenzen oder Passphrasen bleiben
# zurück: Das Arbeitsverzeichnis wird am Ende gelöscht (außer mit GEGENPROBE_DIR).
#
# Aufruf im Wurzelordner dieses Repositorys:
#   sh tools/gegenprobe.sh
# Umgebung:
#   PRODUKT_REPO   Produkt-Repository (Standard: ../virtual-timer-projektstruktur-v3 neben diesem)
#   PRODUKT_REF    Commit, Branch oder Tag (Standard: origin/main)
#   GEGENPROBE_DIR festes Arbeitsverzeichnis (bleibt erhalten); sonst ein neues unter ${TMPDIR:-/tmp}
#   OHNE_BROWSER=1 Browser-Test auslassen
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="${PRODUKT_REPO:-$here/../virtual-timer-projektstruktur-v3}"
ref="${PRODUKT_REF:-origin/main}"
commit="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"

if [ -n "${GEGENPROBE_DIR:-}" ]; then
  work="$GEGENPROBE_DIR"
  mkdir -p "$work"
else
  work="$(mktemp -d "${TMPDIR:-/tmp}/gegenprobe.XXXXXX")"
  trap 'rm -rf "$work"' EXIT INT TERM
fi
echo "Produkt: $repo @ $commit ($ref)"
echo "Arbeitsverzeichnis: $work"

rm -rf "$work/src" "$work/bin" "$work/keys"
mkdir -p "$work/src" "$work/bin"
git -C "$repo" archive --format=tar "$commit" go.mod cmd/licensectl cmd/timerd internal web/noui.go web/ui.go \
  docs/formate/testvektoren | tar -x -C "$work/src"
toolchain="$(sed -n 's/^toolchain //p' "$work/src/go.mod")"
echo "Baue licensectl mit $toolchain"
(cd "$work/src" && GOTOOLCHAIN="$toolchain" CGO_ENABLED=0 go build -trimpath -o "$work/bin/licensectl" ./cmd/licensectl)
"$work/bin/licensectl" version

# Schlüssel A wie am Signierrechner (Datei mit Kennungszeile, AL-17)
"$work/bin/licensectl" keygen -kid test-gegenprobe-a -out "$work/keys" > "$work/keygen.txt"
entry_a="$(sed -n 's/^Oeffentlicher Schluessel: //p' "$work/keygen.txt")"

node "$here/tools/gegenprobe.mjs" "$work" "$toolchain" "$entry_a"

if [ "${OHNE_BROWSER:-}" = 1 ]; then
  echo "Browser-Test: not_run (OHNE_BROWSER=1)"
  exit 0
fi
LICENSECTL="$work/bin/licensectl" TIMERD="$work/bin/timerd" SCHLUESSELDATEI="$work/keys/test-gegenprobe-a.key" \
  SCHLUESSEL_A="$entry_a" GEGENPROBE_DIR="$work" node "$here/tests/browser.mjs"
