#!/usr/bin/env bash
# NixPi upstream tracking (docs/plan-v2/17_UPDATE_UND_UPSTREAM_STRATEGIE.md).
#
#   scripts/nixpi-upstream-sync.sh --check   read-only: what changed upstream, where it may conflict
#   scripts/nixpi-upstream-sync.sh           create/refresh integration/upstream and merge upstream/main
#
# Never pushes and never touches main. After a clean merge: run tests, then update
# packages/coding-agent/package.json -> nixpi.upstreamCommit and merge integration/upstream into main.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
PKG=packages/coding-agent/package.json
UPSTREAM_REF=${UPSTREAM_REF:-upstream/main}
BASE=$(node -p "require('./$PKG').nixpi.upstreamCommit")

git remote get-url upstream >/dev/null 2>&1 || { echo "Remote 'upstream' fehlt (git remote add upstream https://github.com/earendil-works/pi.git)" >&2; exit 1; }
git fetch --quiet upstream

NEW=$(git rev-list --count "$BASE..$UPSTREAM_REF")
echo "Baseline:  $BASE"
echo "Upstream:  $(git rev-parse --short "$UPSTREAM_REF") ($NEW neue Commits)"

if [ "$NEW" -eq 0 ]; then echo "Nichts zu tun."; exit 0; fi

ours=$(mktemp); theirs=$(mktemp)
trap 'rm -f "$ours" "$theirs"' EXIT
git diff --name-only "$BASE" HEAD | sort >"$ours"
git diff --name-only "$BASE" "$UPSTREAM_REF" | sort >"$theirs"
echo
echo "Dateien, die Fork UND Upstream geändert haben (Konfliktkandidaten):"
comm -12 "$ours" "$theirs" | grep -v '^packages/coding-agent/src/nixpi/' | sed 's/^/  /' || true
echo
echo "Upstream-Commits (neueste zuerst, max. 30):"
git log --oneline -30 "$BASE..$UPSTREAM_REF" | sed 's/^/  /'

[ "${1:-}" = "--check" ] && exit 0

git diff --quiet && git diff --cached --quiet || { echo "Arbeitsbaum nicht sauber – abgebrochen." >&2; exit 1; }
git checkout -B integration/upstream
if git merge --no-edit "$UPSTREAM_REF"; then
  echo
  echo "Merge sauber. Nächste Schritte: npm ci && npm run check && (cd packages/coding-agent && npx vitest --run)"
  echo "Danach nixpi.upstreamCommit auf $(git rev-parse "$UPSTREAM_REF") setzen und nach main mergen."
else
  echo
  echo "Konflikte – lösen, dann 'git merge --continue'. main bleibt unberührt." >&2
  exit 2
fi
