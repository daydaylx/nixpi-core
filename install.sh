#!/usr/bin/env bash
# NixPi-Bootstrap für ein (minimales) NixOS: baut NixPi aus diesem Checkout und installiert es
# in das Nix-Profil des aktuellen Benutzers. Idempotent, kein sudo, keine Systemänderung
# (kein nixos-rebuild, keine Partitionen, kein EFI, kein Desktop).
#
#   ./install.sh            installieren bzw. aktualisieren
#   ./install.sh --check    nur Voraussetzungen prüfen
#   ./install.sh --force    auch ohne NixOS fortfahren (nur für Tests)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
REPO_DIR=$PWD
MODE=install
FORCE=0
for a in "$@"; do
  case $a in
    --check) MODE=check ;;
    --force) FORCE=1 ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() { printf 'FEHLER: %s\n' "$1" >&2; [ $# -gt 1 ] && printf '        %s\n' "${@:2}" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || [ "$FORCE" = 1 ] || die "Nicht als root ausführen." "Als normaler Benutzer anmelden und ./install.sh erneut starten."

say "Umgebung prüfen"
[ "$(uname -s)" = Linux ] || die "Nur Linux wird unterstützt (gefunden: $(uname -s))."
OSID=$(. /etc/os-release 2>/dev/null && echo "${ID:-unbekannt}" || echo unbekannt)
if [ "$OSID" != nixos ]; then
  [ "$FORCE" = 1 ] || die "Dies ist kein NixOS (ID=$OSID)." "Das Skript ist für NixOS gedacht. Zum Testen: ./install.sh --force"
  ok "kein NixOS (ID=$OSID), --force aktiv"
else
  ok "NixOS erkannt"
fi

ARCH=$(uname -m)
case $ARCH in
  x86_64 | aarch64) ok "Architektur $ARCH" ;;
  *) die "Architektur $ARCH wird nicht unterstützt (x86_64 und aarch64)." ;;
esac

command -v nix > /dev/null 2>&1 || die "'nix' nicht im PATH." "Neue Login-Shell öffnen (Abmelden/Anmelden) oder /run/current-system/sw/bin prüfen."
NIX_VER=$(nix --version | grep -Eo '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1)
NIX_MAJOR=${NIX_VER%%.*}
NIX_MINOR=${NIX_VER#*.}; NIX_MINOR=${NIX_MINOR%%.*}
if [ "$NIX_MAJOR" -lt 2 ] || { [ "$NIX_MAJOR" -eq 2 ] && [ "$NIX_MINOR" -lt 18 ]; }; then
  die "Nix $NIX_VER ist zu alt (benötigt >= 2.18)."
fi
ok "Nix $NIX_VER"

# Flakes/nix-command sind auf frischem NixOS meist noch aus: nur für diesen Lauf aktivieren.
NIX=(nix --extra-experimental-features 'nix-command flakes')
if nix config show experimental-features 2> /dev/null | grep -q flakes; then
  ok "Flakes bereits aktiv"
else
  ok "Flakes werden nur für diesen Lauf per Kommandozeile aktiviert (Systemkonfiguration bleibt unverändert)"
fi

command -v git > /dev/null 2>&1 || die "'git' fehlt." "Einmalig: nix-shell -p git" "(Flakes lesen den Checkout über git.)"
git -C "$REPO_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1 || die "$REPO_DIR ist kein Git-Checkout."
[ -f flake.nix ] && [ -f flake.lock ] || die "flake.nix/flake.lock fehlen in $REPO_DIR."
grep -Eq 'Hash *= *lib\.fakeHash' nix/package.nix && die "nix/package.nix enthält noch lib.fakeHash (falscher Stand?)."
COMMIT=$(git rev-parse HEAD)
ok "Checkout $COMMIT"
git diff --quiet HEAD -- 2> /dev/null || echo "    Hinweis: Checkout hat lokale Änderungen; sie fließen in den Build ein."

if ! curl -fsS --max-time 10 -o /dev/null https://cache.nixos.org/nix-cache-info 2> /dev/null; then
  echo "    Warnung: cache.nixos.org nicht erreichbar (Netzwerk?). Der Build kann sehr lange dauern oder scheitern."
fi

[ "$MODE" = check ] && { say "Voraussetzungen erfüllt."; exit 0; }

say "NixPi bauen (erster Lauf lädt Abhängigkeiten, das dauert einige Minuten)"
OUT=$("${NIX[@]}" build "$REPO_DIR#nixpi" --no-link --print-out-paths) \
  || die "nix build fehlgeschlagen." "Meldungen oben prüfen; bei Netzwerkproblemen erneut ausführen (idempotent)."
[ -x "$OUT/bin/nixpi" ] || die "Build lieferte kein $OUT/bin/nixpi."
ok "gebaut: $OUT"

say "In Benutzerprofil installieren"
if "${NIX[@]}" profile list 2> /dev/null | grep -qF "$OUT"; then
  ok "diese Version ist bereits installiert"
else
  # Alte Version (falls vorhanden) entfernen, dann die gebaute Store-Version installieren.
  if "${NIX[@]}" profile list 2> /dev/null | grep -Eq '(^|[^[:alnum:]_-])nixpi([^[:alnum:]_-]|$)'; then
    "${NIX[@]}" profile remove nixpi > /dev/null 2>&1 || true
  fi
  # 'profile add' ersetzt das veraltete 'profile install' (ab Nix 2.2x); ältere Versionen kennen nur install.
  "${NIX[@]}" profile add "$OUT" 2> /dev/null || "${NIX[@]}" profile install "$OUT" \
    || die "nix profile add/install fehlgeschlagen."
  ok "installiert"
fi

say "Installation prüfen"
PROFILE_BIN="${NIX_PROFILE_BIN:-$HOME/.nix-profile/bin}"
[ -x "$PROFILE_BIN/nixpi" ] || PROFILE_BIN="${XDG_STATE_HOME:-$HOME/.local/state}/nix/profile/bin"
[ -x "$PROFILE_BIN/nixpi" ] || die "nixpi liegt nicht im Profil ($HOME/.nix-profile/bin)."
"$PROFILE_BIN/nixpi" version || die "'nixpi version' fehlgeschlagen."
case ":$PATH:" in
  *":$PROFILE_BIN:"*) ok "nixpi ist im PATH" ;;
  *) echo "    Hinweis: $PROFILE_BIN ist in dieser Shell noch nicht im PATH."
     echo "    Neu anmelden oder:  export PATH=\"$PROFILE_BIN:\$PATH\"" ;;
esac

say "Optionale Komponenten"
for t in nh mcp-nixos git; do
  # Im nixpi-Wrapper mitgeliefert (PATH-Suffix); ein vorhandenes System-Programm hat Vorrang.
  if grep -aq -- "-$t-" "$OUT/bin/nixpi"; then ok "$t (im Paket enthalten)"; else echo "    fehlt: $t"; fi
done
command -v sudo > /dev/null 2>&1 && ok "sudo (für 'switch' nötig)" || echo "    fehlt: sudo (nur für das spätere Aktivieren nötig)"
git config --global user.name > /dev/null 2>&1 && git config --global user.email > /dev/null 2>&1 \
  || echo "    Hinweis: git user.name/email fehlen (für Commits von NixPi):
             git config --global user.name 'Name'; git config --global user.email 'mail@example.org'"
[ -d "$HOME/nixos-config" ] && ok "$HOME/nixos-config existiert" \
  || echo "    $HOME/nixos-config fehlt noch (wird von 'nixpi bootstrap' angelegt, nicht von diesem Skript)."

cat << EOF

NixPi $COMMIT ist installiert.
Nächste Schritte:
  nixpi version
  nixpi                # Modell/Login in NixPi einrichten (siehe README)
  nixpi bootstrap      # optional, fragt vor dem Anlegen von ~/nixos-config nach
EOF
