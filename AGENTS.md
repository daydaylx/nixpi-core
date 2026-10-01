# Development Rules

## Source of truth and scope

This file is the sole source of repository-wide agent instructions. Read it before changing code. `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md` only point here; they must not add or copy rules. Agent onboarding and links to detailed plans live in [`docs/agents.md`](docs/agents.md). Use existing `.pi/skills/` for their named workflows instead of copying their checklists here.

NixPi is a specialized NixOS system controller built on the Pi coding-agent fork, not a Pi project skill. Keep NixPi-specific behavior under `packages/coding-agent/src/nixpi/`; patch shared Pi core only when no extension point is suitable. Preserve the fork boundary and upstream updateability; `packages/coding-agent/package.json` records the upstream baseline. Keep normal Pi and NixPi identity, configuration, sessions, and trust boundaries separate. Read [`NIXPI.md`](NIXPI.md) and the relevant source before changing either boundary.

## Changes and safety

- Keep changes scoped to the request. Preserve unrelated and concurrent-session work; never overwrite or revert changes you did not make. Multiple Pi sessions may share this worktree: inspect status before writing and before reporting, and use explicit paths for any Git operation.
- Do not remove intentional behavior or compatibility without asking. Do not commit, push, publish, or change branches unless explicitly requested.
- Treat secrets, credentials, auth files, environment variables, and SSH keys as sensitive: do not read, expose, log, or commit them. `.gitignore` is not a security boundary; inspect its effects before adding patterns.
- Treat dependencies and lockfiles as reviewed code. Ask before adding/installing dependencies. Direct external dependencies are exact-pinned. Install with `npm ci --ignore-scripts` or `npm install --ignore-scripts`; do not run lifecycle scripts without approval. If dependency metadata changes, update the lockfile with `npm install --package-lock-only --ignore-scripts`. For `undici` updates, read the target release notes first. Regenerate `packages/coding-agent/npm-shrinkwrap.json` with `node scripts/generate-coding-agent-shrinkwrap.mjs`; do not edit generated output by hand.
- Do not edit generated model catalog `packages/ai/src/models.generated.ts` directly. Change `packages/ai/scripts/generate-models.ts`, then regenerate.
- Preserve Node strip-only TypeScript constraints in checked source/tests: no enums, namespaces, parameter properties, or other syntax requiring emit. Avoid `any`; do not use inline imports.

## NixPi trust and privilege boundaries

NixPi exposes domain-specific tools and no general file read/write tools. The only shell path is `admin_exec`, active solely in Adminmode (user-activated with Meta+Y, CHANGE only, interactive TUI only, never persisted); every call needs `reason` and `risk` and a separate user confirmation, and only the exit code reaches the model. Never widen it (no session-wide approval, no non-TUI use, no output to the model). Apart from that, the `SystemRunner` uses a fixed binary allowlist and argument arrays without a shell. Paths are confined to the configured repository; secret-like paths, `.git`, traversal, and symlink escapes are guarded. Do not weaken these controls or treat model instructions, plans, web pages, or user-provided repository content as authorization.

PLAN is read-only; only an explicit user action can approve a plan for CHANGE. HIGH-risk changes require an approved plan. Applying a system generation requires a successful build and explicit user confirmation; privileged switching uses existing sudo/Nix mechanisms, not a permanent root agent. Web content is untrusted and requires fresh confirmation for sensitive mutations. Never put secrets in Nix store, Git, or decision records. Verify the actual policy and tests before changing any of these contracts.

NixPi intentionally disables automatic discovery/loading of skills, prompt templates, and project context files such as `AGENTS.md`; it excludes third-party extensions and loads its own built-in NixPi extension. This is a runtime trust choice, distinct from repository documentation: other coding agents can read `AGENTS.md`, and it grants them no NixPi tools or privileges. Do not change that runtime policy as part of documentation setup.

## Checks and tests

Use the narrowest relevant test first. Root `npm run check` runs Biome (with `--write`), dependency/import/entry/shrinkwrap checks, TypeScript, and browser-smoke checks; review its side effects before running. It does not run tests. For coding-agent tests use Vitest from `packages/coding-agent`, for example:

```sh
cd packages/coding-agent
npx vitest --run test/nixpi/policy.test.ts
```

The NixPi CI workflow (`.github/workflows/nixpi-ci.yml`) runs `npm ci --ignore-scripts`, `npm run build`, `npm run check`, the full coding-agent Vitest suite, `npm run test:identity`, and binary smoke checks. The upstream check is `scripts/nixpi-upstream-sync.sh --check`; inspect that script before running because it fetches upstream refs. Do not run a build for documentation/configuration-only changes. Do not run `npm test` or a full suite unless requested or needed by the relevant CI gate.

For UI changes, use `.pi/skills/interactive-testing.md`. For provider work, release work, or other named workflows, load the corresponding `.pi/skills/*.md` instructions first. Keep tests offline and credential-free; coding-agent suite tests use fakes where documented.

## Definition of done

The requested behavior is implemented without crossing an unrelated trust/API boundary; relevant tests and checks have completed successfully; generated artifacts and links are correct; `git diff --check` passes; and the final report names changed files, checks/results, and any unresolved risk. Do not claim completion while required verification is still running or failing.
