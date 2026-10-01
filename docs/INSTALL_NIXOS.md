# NixPi auf einem minimalen NixOS installieren (nur TTY + Netzwerk)

Voraussetzung: NixOS ist installiert, Benutzer mit Netzwerk angemeldet (kein Desktop, kein Browser nötig).
Das Repository `daydaylx/nixpi-core` ist **privat**, daher zuerst ein Device-Login mit `gh`.

```sh
nix-shell -p git gh                                  # temporäre Shell mit git + gh
gh auth login -h github.com -p https -w              # zeigt Code + URL; am Smartphone bestätigen
gh auth setup-git                                    # git nutzt das gh-Token
git clone -b nixpi/main https://github.com/daydaylx/nixpi-core.git ~/nixpi-core
exit                                                 # nix-shell verlassen
cd ~/nixpi-core && ./install.sh
nixpi version
nixpi
```

`gh` zeigt einen Einmalcode; diesen auf <https://github.com/login/device> am Smartphone eingeben. Ist kein
Browser vorhanden, den Code trotzdem dort bestätigen; `gh` wartet darauf (nicht auf einem echten
NixOS getestet).

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
- Das verwaltete Config-Repo `~/nixos-config` legt erst `nixpi bootstrap` an (mit Rückfrage).
  Vorher `git config --global user.name/user.email` setzen.

## Aktualisieren

`cd ~/nixpi-core && git pull && ./install.sh`

## Auf einem echten NixOS noch zu validieren

`nixpi bootstrap`, `nh os switch`/`nixos-rebuild`, sudo-Verhalten, Generationen/Rollback und die
Evaluierbarkeit des erzeugten Flakes sind nur gegen Fakes getestet. Ein privates `nixpi-core` als
Flake-Input in `~/nixos-config` braucht einen GitHub-Token für Nix (`access-tokens`); alternativ
`install.sh` weiterverwenden statt `--nixpi-flake`.

## Pflege des Pakets

- `package-lock.json` geändert: `npmDepsHash` in `nix/package.nix` auf `lib.fakeHash`, bauen, den
  „got:“-Hash eintragen.
- Modellkatalog: Snapshot in `nix/model-data/` (siehe dortiges README).
- Nixpkgs-Stand: `flake.lock` (Input `nixos-26.05`).
