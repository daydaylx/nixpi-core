# NixPi auf einem minimalen NixOS installieren (nur TTY + Netzwerk)

Voraussetzung: NixOS ist installiert, Benutzer mit Netzwerk angemeldet (kein Desktop, kein Browser nötig).
Das Repository `daydaylx/nixpi-core` ist öffentlich, ein GitHub-Login ist nicht nötig.

```sh
nix-shell -p git --run 'git clone -b nixpi/main https://github.com/daydaylx/nixpi-core.git ~/nixpi-core'
cd ~/nixpi-core && ./install.sh
nixpi version
nixpi
```

(Nur falls das Repo wieder privat wird: `nix-shell -p git gh`, dann `gh auth login -h github.com -p https -w`
mit Einmalcode am Smartphone und `gh auth setup-git`; auf echtem NixOS nicht getestet.)

## Was `install.sh` tut (und lässt)

Prüft NixOS, Architektur (x86_64/aarch64), Nix >= 2.18, Git-Checkout und Netz, baut `.#nixpi` und
installiert es mit `nix profile` in das **Benutzerprofil**. Flakes werden nur per Kommandozeile für
den Lauf aktiviert. Es nutzt kein `sudo` und ändert weder Partitionen, EFI, Bootloader noch die
Systemkonfiguration, installiert keinen Desktop und führt kein `nixos-rebuild` aus.
Mehrfaches Ausführen ist sicher (gleiche Version: nichts zu tun; neuer Stand: Profil wird ersetzt).
`./install.sh --check` prüft nur die Voraussetzungen.

Im Paket enthalten (PATH-Suffix des `nixpi`-Wrappers): `git`, `nh`, `mcp-nixos`. Ein System-`nix` wird
vorausgesetzt (auf NixOS immer vorhanden). `sudo` ist nur für das spätere Aktivieren nötig.

## Erster Start

- Konfiguration/Sitzungen liegen in `~/.nixpi/agent` (nie in `~/.pi`).
- `nixpi` startet auch ohne Modell; ohne Zugang erscheint „No models available“. Zugang mit `/login`
  (OAuth/API-Key) in der TUI einrichten, API-Keys nie ins Repo schreiben.
- Das verwaltete Config-Repo `~/nixos-config` legt `nixpi bootstrap` an (mit Rückfrage; existiert es
  schon, wird nichts überschrieben). Es übernimmt die bestehende `/etc/nixos/configuration.nix`
  (`hosts/<host>/configuration.nix`) und `hardware-configuration.nix`. Vorher
  `git config --global user.name/user.email` setzen.
- Das Repo vorab erzeugen (auf Fedora, gegen die NixOS-Dateien) ist möglich; sein `flake.lock` pinnt
  nixpkgs, home-manager und NixPi. Es ist **nicht aktiviert**: erst `nh os build ~/nixos-config
  --hostname <host>` prüfen, dann bewusst `nh os switch`. Das Flake evaluiert (getestet auf Fedora);
  ein Switch ist nicht getestet.

## Aktualisieren

`cd ~/nixpi-core && git pull && ./install.sh`

## Auf einem echten NixOS noch zu validieren

`nixpi bootstrap`, `nh os switch`/`nixos-rebuild`, sudo-Verhalten, Generationen/Rollback und die
Evaluierbarkeit des erzeugten Flakes sind nur gegen Fakes getestet. Als Flake-Input in `~/nixos-config` (`--nixpi-flake github:daydaylx/nixpi-core/nixpi/main`) ist
`nixpi-core` ohne Token erreichbar.

## Pflege des Pakets

- `package-lock.json` geändert: `npmDepsHash` in `nix/package.nix` auf `lib.fakeHash`, bauen, den
  „got:“-Hash eintragen.
- Modellkatalog: Snapshot in `nix/model-data/` (siehe dortiges README).
- Nixpkgs-Stand: `flake.lock` (Input `nixos-26.05`).
