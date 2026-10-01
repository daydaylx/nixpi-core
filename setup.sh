#!/usr/bin/env bash
# Ein-Befehl-Setup für NixPi auf minimalem NixOS: prüft Umgebung, Netzwerk, Uhrzeit, Platz und RAM,
# aktualisiert den Checkout, führt install.sh mit Wiederholungen aus und prüft am Ende `nixpi`.
# Ändert KEIN System (kein nixos-rebuild/switch, kein sudo, keine Partitionen/EFI/Desktop).
# Alle Ausgaben zusätzlich in ~/nixpi-setup.log.
#
#   ./setup.sh                 Setup
#   ./setup.sh --no-pull       Checkout nicht aktualisieren
#   ./setup.sh --build-config  zusätzlich ~/nixos-config bauen (ohne Aktivierung) – dauert länger
#   ./setup.sh --force         ohne NixOS-Erkennung (nur Test)
set -uo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG=${NIXPI_SETUP_LOG:-$HOME/nixpi-setup.log}
PULL=1 BUILD_CONFIG=0 FORCE=0
for a in "$@"; do
  case $a in
    --no-pull) PULL=0 ;;
    --build-config) BUILD_CONFIG=1 ;;
    --force) FORCE=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $a" >&2; exit 2 ;;
  esac
done

# Auf nacktem NixOS fehlt git. Dann einmalig in einer 'nix shell' mit gepinntem git neu starten
# (nixpkgs-Stand aus flake.lock). Das passiert vor der Log-Umleitung, damit nichts doppelt geloggt wird.
if ! command -v git > /dev/null 2>&1 && [ -z "${NIXPI_SETUP_INNER:-}" ] && command -v nix > /dev/null 2>&1; then
  REV=$(sed -n 's/.*"rev": *"\([0-9a-f]\{40\}\)".*/\1/p' "$REPO_DIR/flake.lock" 2> /dev/null | head -n1)
  REF=${REV:+github:NixOS/nixpkgs/$REV}
  echo "git fehlt auf diesem System – starte neu in 'nix shell' (${REF:-nixpkgs}#git) …"
  NIXPI_SETUP_INNER=1 exec nix --extra-experimental-features 'nix-command flakes' shell "${REF:-nixpkgs}#git" -c "$REPO_DIR/setup.sh" "$@"
fi
[ -t 0 ] && [ -t 1 ] && TTY=1 || TTY=0   # vor der Umleitung auf tee feststellen
exec > >(tee -a "$LOG") 2>&1
echo "=== nixpi setup $(date '+%F %T') (Log: $LOG) ==="

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
warn() { printf '    WARNUNG: %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done
  printf '        Log: %s – nach Behebung einfach erneut starten (idempotent).\n' "$LOG"; exit 1; }
interactive() { [ "$TTY" = 1 ]; }

online() { curl -fsS --max-time 8 -o /dev/null https://cache.nixos.org/nix-cache-info 2> /dev/null; }

step "Benutzer und System"
[ "$(id -u)" -ne 0 ] || [ "$FORCE" = 1 ] || fail "Nicht als root ausführen." "Als normaler Benutzer anmelden (z. B. 'd')."
OSID=$(. /etc/os-release 2> /dev/null && echo "${ID:-?}" || echo "?")
if [ "$OSID" != nixos ] && [ "$FORCE" != 1 ]; then fail "Kein NixOS erkannt (ID=$OSID)." "Nur zum Testen: ./setup.sh --force"; fi
ok "Benutzer $(id -un), System $OSID, $(uname -m)"
for t in nix git curl awk sed grep tee df; do
  command -v "$t" > /dev/null 2>&1 && continue
  case $t in
    nix) fail "'nix' fehlt im PATH." "Neu anmelden; prüfe /run/current-system/sw/bin." ;;
    git) fail "git konnte auch per 'nix shell' nicht bereitgestellt werden." "Netzwerk prüfen und erneut starten, oder einmalig: nix-shell -p git" ;;
    curl) fail "'curl' fehlt." "Einmalig: nix-shell -p curl --run ./setup.sh   (oder curl in configuration.nix ergänzen)" ;;
    *) fail "'$t' fehlt (Basis-Systemprogramm)." "Ungewöhnlich für NixOS – ist es ein anderes System? Dann ./setup.sh --force nur zum Testen." ;;
  esac
done
command -v nmcli > /dev/null 2>&1 || warn "nmcli/nmtui fehlen (NetworkManager nicht aktiv?): Netzwerk dann manuell einrichten."
command -v sudo > /dev/null 2>&1 || warn "sudo fehlt (nur für das spätere Aktivieren nötig)."

step "Uhrzeit (falsche Uhr = TLS-Fehler)"
YEAR=$(date +%Y)
if [ "$YEAR" -lt 2026 ]; then
  warn "Systemjahr $YEAR wirkt falsch."
  timedatectl status 2> /dev/null | grep -Ei 'synchronized|Local time' || true
  echo "    Netzwerk verbinden; NTP stellt die Uhr meist selbst. Dann erneut starten."
else
  ok "Datum $(date +%F)"
fi

step "Speicherplatz und RAM"
FREE_GB=$(df -BG --output=avail /nix 2> /dev/null | tail -n1 | tr -dc 0-9)
if [ -n "${FREE_GB:-}" ] && [ "$FREE_GB" -lt 8 ]; then
  fail "Nur ${FREE_GB} GB frei auf /nix (benötigt ≈ 8 GB)." "Platz schaffen: nix-collect-garbage -d (als Benutzer; löscht alte Profile)."
fi
ok "${FREE_GB:-?} GB frei"
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
[ "$((MEM_MB + SWAP_MB))" -ge 3000 ] && ok "RAM ${MEM_MB} MB, Swap ${SWAP_MB} MB" \
  || warn "Wenig Speicher (RAM ${MEM_MB} MB + Swap ${SWAP_MB} MB): der npm-Build kann scheitern."

step "Netzwerk"
tries=0
until online; do
  tries=$((tries + 1))
  if ! ip route 2> /dev/null | grep -q '^default'; then echo "    keine Standardroute (nicht verbunden)."; else echo "    cache.nixos.org nicht erreichbar (DNS/Uhrzeit/Proxy?)."; fi
  if command -v nmcli > /dev/null 2>&1; then nmcli -t -f DEVICE,TYPE,STATE device 2> /dev/null | sed 's/^/    /' | head -6; fi
  if interactive && [ "$tries" -le 3 ] && command -v nmtui > /dev/null 2>&1; then
    echo "    Öffne nmtui (Verbindung aktivieren/WLAN wählen, danach beenden) …"; sleep 2; nmtui < /dev/tty > /dev/tty || true
  elif [ "$tries" -le 6 ]; then
    echo "    warte 10 s und versuche erneut ($tries/6) …"; sleep 10
  else
    fail "Kein Netzwerk zu cache.nixos.org." "WLAN: nmtui   oder   nmcli device wifi connect <SSID> --ask" "Danach ./setup.sh erneut."
  fi
  [ "$tries" -gt 6 ] && fail "Kein Netzwerk zu cache.nixos.org." "WLAN: nmtui   oder   nmcli device wifi connect <SSID> --ask"
done
ok "Netzwerk ok"

step "Checkout aktualisieren"
cd "$REPO_DIR" || fail "Verzeichnis $REPO_DIR nicht erreichbar."
if [ "$PULL" = 1 ] && git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  if [ -n "$(git status --porcelain --untracked-files=no 2> /dev/null)" ]; then
    warn "Lokale Änderungen im Checkout – kein Pull (nichts wird überschrieben)."
  elif git pull --ff-only 2>&1 | sed 's/^/    /'; [ "${PIPESTATUS[0]}" -eq 0 ]; then
    ok "aktuell: $(git log --oneline -1)"
  else
    warn "git pull fehlgeschlagen (offline/Verlauf abweichend?) – mache mit dem lokalen Stand weiter: $(git log --oneline -1)"
  fi
else
  ok "Stand: $(git log --oneline -1 2> /dev/null || echo unbekannt)"
fi
git config --global user.name > /dev/null 2>&1 || warn "git user.name fehlt (git config --global user.name 'Name')"
git config --global user.email > /dev/null 2>&1 || warn "git user.email fehlt (git config --global user.email 'mail')"

step "NixPi installieren (install.sh, bis zu 3 Versuche)"
INSTALL_ARGS=()
[ "$FORCE" = 1 ] && INSTALL_ARGS+=(--force)
n=0
until ./install.sh "${INSTALL_ARGS[@]}"; do
  n=$((n + 1))
  if [ "$n" -ge 3 ]; then
    fail "install.sh scheiterte dreimal." \
      "Häufige Ursachen: Netzwerkabbruch (erneut starten), zu wenig Platz/RAM, Cache-Fehler." \
      "Meldungen oben bzw. im Log prüfen; bereits geladene Pakete bleiben im Store, ein Neustart geht schneller."
  fi
  echo "    Versuch $n fehlgeschlagen – warte 15 s …"; sleep 15
  online || { echo "    Netz weg – warte auf Verbindung …"; for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do online && break; sleep 10; done; }
done

step "PATH und Alias sicherstellen"
PB="$HOME/.nix-profile/bin"
[ -x "$PB/nixpi" ] || PB="${XDG_STATE_HOME:-$HOME/.local/state}/nix/profile/bin"
[ -x "$PB/nixpi" ] || fail "nixpi liegt nach der Installation nicht im Profil."
case ":$PATH:" in *":$PB:"*) ;; *) export PATH="$PB:$PATH"; warn "Profil war nicht im PATH; für diese Sitzung ergänzt (bei neuer Anmeldung normalerweise automatisch)." ;; esac
hash -r
ok "nixpi: $(command -v nixpi)"

step "Prüfung"
nixpi version || fail "'nixpi version' fehlgeschlagen."
if [ -s "$HOME/.nixpi/agent/auth.json" ]; then ok "Zugang vorhanden (~/.nixpi/agent/auth.json)"
else warn "Kein Provider-Zugang: in nixpi '/login' (OpenAI per Device-Code) oder OPENAI_API_KEY setzen."; fi
[ -d "$HOME/nixos-config/.git" ] && ok "~/nixos-config vorhanden ($(git -C "$HOME/nixos-config" log --oneline -1 2> /dev/null))" \
  || warn "~/nixos-config fehlt – 'nixpi bootstrap' legt es an."

if [ "$BUILD_CONFIG" = 1 ]; then
  step "~/nixos-config bauen (ohne Aktivierung)"
  if command -v nh > /dev/null 2>&1 || [ -x "$PB/nh" ]; then
    NH=$(command -v nh || echo "$PB/nh")
    "$NH" os build "$HOME/nixos-config" --hostname "$(hostname)" || warn "Build der Systemkonfiguration fehlgeschlagen (siehe oben) – nichts wurde aktiviert."
  else
    nix --extra-experimental-features 'nix-command flakes' build --no-link "$HOME/nixos-config#nixosConfigurations.$(hostname).config.system.build.toplevel" \
      || warn "Build der Systemkonfiguration fehlgeschlagen – nichts wurde aktiviert."
  fi
fi

cat << EOF

Fertig. Nichts am System wurde aktiviert.
  nixpi            starten
  Aktivieren später bewusst: nh os switch ~/nixos-config --hostname $(hostname)
EOF
if interactive && [ "$FORCE" != 1 ]; then
  printf '\nnixpi jetzt starten? [J/n] '; read -r a < /dev/tty
  case ${a:-j} in [jJyY]*) exec nixpi < /dev/tty > /dev/tty 2>&1 ;; esac
fi
