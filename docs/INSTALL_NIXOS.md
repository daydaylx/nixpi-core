# NixPi auf einem minimalen NixOS installieren (nur TTY + Netzwerk)

Voraussetzung: NixOS ist installiert, Benutzer mit Netzwerk angemeldet (kein Desktop, kein Browser nötig).
Das Repository `daydaylx/nixpi-core` ist öffentlich, ein GitHub-Login ist nicht nötig.

```sh
nix-shell -p git --run 'git clone -b nixpi/main https://github.com/daydaylx/nixpi-core.git ~/nixpi-core'
cd ~/nixpi-core && ./setup.sh
nixpi version
nixpi
```

(Nur falls das Repo wieder privat wird: `nix-shell -p git gh`, dann `gh auth login -h github.com -p https -w`
mit Einmalcode am Smartphone und `gh auth setup-git`; auf echtem NixOS nicht getestet.)

## Ein-Befehl-Setup: `setup.sh` (Alias `nixpi-setup`)

`./setup.sh` fasst alles zusammen und fängt typische Probleme ab: fehlendes `git` (startet sich in
einer `nix shell` neu, nixpkgs-Stand aus `flake.lock`), kein Netzwerk (öffnet `nmtui`, wartet, wiederholt),
falsche Uhr, zu wenig Platz/RAM, fehlgeschlagener `git pull` (macht lokal weiter), Netzabbruch beim Build
(bis zu 3 Versuche) und ein altes `nixpi` im Profil (wird ersetzt). Es aktiviert nie das System
(`--build-config` baut `~/nixos-config` zusätzlich, ohne Aktivierung). Log: `~/nixpi-setup.log`.

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
- OpenAI headless: `/login` → OpenAI Codex (ChatGPT-Konto) → Methode „device code": die TUI zeigt einen
  Code, den du am Smartphone auf der angezeigten OpenAI-Seite eingibst (kein Browser/Callback am Rechner
  nötig). Alternative: `export OPENAI_API_KEY=...` vor `nixpi` (API-Abrechnung statt ChatGPT-Abo).
  Tokens liegen in `~/.nixpi/agent/auth.json`; nicht zwischen Rechnern kopieren (Refresh-Token).
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
