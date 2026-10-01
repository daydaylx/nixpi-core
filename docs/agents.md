# Agent onboarding

Start with the repository-wide [`AGENTS.md`](../AGENTS.md). It is the single source of truth for coding rules, verification, and safety boundaries. `CLAUDE.md` and `GEMINI.md` import it; GitHub Copilot gets a short pointer. Keep provider-specific files as pointers, not alternate rulebooks.

## Understand the project

NixPi is a system controller implemented as a fork of Pi's coding-agent package. It is not a project-local Pi skill. [`NIXPI.md`](../NIXPI.md) summarizes the fork; the original design is in `~/Downloads/NixPi_Gesamtplan_V2` when available. The upstream commit baseline is recorded in `packages/coding-agent/package.json`.

Keep NixPi code in `packages/coding-agent/src/nixpi/` where possible. Shared Pi-core changes increase merge cost: prefer existing extension points and keep provider, session, TUI, and compaction behavior upstream-compatible. `scripts/nixpi-upstream-sync.sh` documents the integration workflow; its `--check` still fetches upstream refs.

## Instructions versus runtime resources

The files in `.pi/skills/`, `.pi/prompts/`, and `.pi/extensions/` are Pi resources for their intended workflows; they are not additional repository-wide instruction sources. Pi loads `AGENTS.md` as project context, and other coding agents may read it too.

NixPi deliberately disables automatic loading of skills, prompt templates, and project context (`AGENTS.md`, `CLAUDE.md`) at runtime, and excludes third-party extensions. Its own built-in NixPi extension remains active; themes are separately configured. This is a trust boundary, not a documentation omission: an instruction file does not enable tools or grant privileges. See `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/nixpi/policy/resources.ts`, and `packages/coding-agent/src/extensions/index.ts`.

## NixPi safety model

The model receives NixPi domain tools, not arbitrary file read/write tools. A shell is available only through `admin_exec` in user-activated, non-persistent Adminmode (CHANGE, interactive TUI), with per-command confirmation and only the exit code returned to the model; see `NIXPI.md`. Other runtime commands are restricted to an explicit binary allowlist without a shell; repository paths and secret-like files are guarded. PLAN is read-only, and changing to CHANGE requires explicit user action. HIGH-risk changes require an approved plan. System activation requires a successful build and explicit confirmation; privileged operations use the existing sudo/Nix mechanisms. Web results are untrusted and cannot grant authorization. Never put credentials in Nix store, Git, or decision records.

These are implementation-enforced boundaries, not suggestions for an agent to bypass. Before touching them, inspect the relevant policy, tool implementation, and tests under `packages/coding-agent/src/nixpi/` and `packages/coding-agent/test/nixpi/`.

## Tests and completion

For a focused NixPi test, run from `packages/coding-agent`, for example:

```sh
npx vitest --run test/nixpi/policy.test.ts
```

NixPi CI also runs root `npm run check`, a build, the full coding-agent Vitest suite, identity tests, and binary smoke checks; see `.github/workflows/nixpi-ci.yml`. Do not run a build for Markdown/config-only work. `npm run check` includes Biome `--write`, so review its workspace-wide effects before running it.

A task is complete when its acceptance criteria are met, relevant checks have finished successfully, generated files and links are correct, `git diff --check` passes, and the report states exactly what changed and what was verified. Do not commit unless asked. For changes spanning concurrent Pi sessions, preserve other sessions' files and stage explicit paths only if a commit is requested.
