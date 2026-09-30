# NixPi (Fork von Pi)

NixPi ist ein NixOS-Systemagent auf Basis des Pi-Cores. Planung und Entscheidungen: Repo `nixpi` (docs/plan-v2).
Dieses Repo ist ein Fork von `earendil-works/pi`; Baseline siehe `packages/coding-agent/package.json` → `nixpi.upstreamCommit`.

## Unterschiede zu Pi (bewusster Fork-Diff)

| Bereich | Änderung |
|---|---|
| Identität | `piConfig.name=nixpi`, `configDir=.nixpi`, Binary `nixpi`, Env `NIXPI_CODING_AGENT_DIR` (kein Teilen von `~/.pi`) |
| Toolset | keine Built-in-Tools (kein bash/edit/write/read); `DEFAULT_TOOL_NAMES=[]`, `nixpiBaseToolDefinitions()` liefert `{}` |
| Extensions | nur Built-in `nixpi`; Dateien/Pakete/Projekt-Extensions werden nie geladen (`policy/resources.ts`); Skills, Prompt-Templates, AGENTS.md-Kontext aus |
| Entry | `src/cli.ts` → `runNixpiCli` (`recover`, `bootstrap`, `version`), Update-Check und Telemetrie standardmäßig aus |
| Neuer Code | `packages/coding-agent/src/nixpi/` (Modi, Tools, Policy, Nix, History, Bootstrap, Web) |

Alles andere (Provider, Sessions, TUI, Compaction, Auth) bleibt unverändert.

## Modi und Tools

- **CHANGE**: lesen, verifizieren, `config_patch`/`config_create_module`, `nix_build`, `nix_test`/`nix_switch` (Nutzerbestätigung + sudo), `git_commit` (Nachricht aus Intent), `decision_write`, `generation_rollback`.
- **PLAN** (read-only): Lese-Tools, `ask_user`, `plan_finalize`. Übergang nach CHANGE nur durch Nutzeraktion („Ausführen“ / `/ausfuehren`).
- Risiko-Gate: HIGH (Boot, Kernel, sudo, Benutzer, Firewall, Dateisysteme, Verschlüsselung, Secrets) nur nach freigegebenem PLAN.
- Konfiguration: `NIXPI_CONFIG_REPO` (Standard `~/nixos-config`), `NIXPI_HOST` (Standard Hostname), `NIXPI_MCP_NIXOS_CMD`, `NIXPI_WEB=1` + `EXA_API_KEY` (optionale Websuche).

## Entwickeln

```sh
npm ci && npm run build
node packages/coding-agent/dist/bundle/cli.js version
cd packages/coding-agent && npx vitest --run        # NixPi-Tests: test/nixpi/
scripts/nixpi-upstream-sync.sh --check               # Upstream-Stand prüfen
```

`packages/coding-agent/test/nixpi-quarantine.json` listet Upstream-Tests, die Pi-Identität/Pi-Defaults prüfen und bewusst ausgeschlossen sind (grün auf Tag `upstream-baseline-2026-09-30`).

## Nix-Paket

`flake.nix` + `nix/package.nix` + `nix/module.nix` sind ein **ungebauter Entwurf** (kein Nix in der Entwicklungsumgebung): `npmDepsHash` ist Platzhalter, `flake.lock` fehlt.
