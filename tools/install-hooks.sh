#!/usr/bin/env bash
#
# Installs the repo's git hooks. Run once, per clone:
#
#     ./tools/install-hooks.sh
#
# The pre-commit hook runs `contracts/codegen.sh --check`, which fails the commit
# if Generated/Contracts.swift or packages/contracts/src/generated.ts has drifted
# from contracts/schema/. (server/src/contracts.ts is now a re-export shim that
# codegen never writes; matching on it let a hand-edited generated.ts through.)
#
# This is not ceremony. Hand-maintained Swift and TypeScript types WILL diverge
# by hour 15, and the resulting bug reads as a solver fault — the field is simply
# missing on one side, so the value silently arrives as nil and furniture lands
# at the origin. That costs two hours. This hook costs four seconds a commit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks)"
HOOK_DIR="$(cd "$REPO_ROOT" && cd "$HOOK_DIR" && pwd)"

cat > "$HOOK_DIR/pre-commit" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Only run when a schema or a generated file is actually part of this commit —
# a four-second npx spin on every unrelated commit is how a hook gets deleted.
if git diff --cached --name-only | grep -qE '^(.*/)?(contracts/schema/|ios/SpatialCore/Sources/SpatialCore/Generated/|packages/contracts/src/generated\.ts)'; then
  echo "pre-commit: checking generated contracts are up to date..."
  CODEGEN="$(git rev-parse --show-toplevel)/contracts/codegen.sh"
  [ -x "$CODEGEN" ] || CODEGEN="$(git rev-parse --show-toplevel)/reality-editor/contracts/codegen.sh"
  "$CODEGEN" --check
fi
HOOK

chmod +x "$HOOK_DIR/pre-commit"
echo "installed pre-commit hook -> $HOOK_DIR/pre-commit"
echo
echo "It runs contracts/codegen.sh --check when a schema or generated file is staged."
echo "Skip it in a genuine emergency with: git commit --no-verify"
