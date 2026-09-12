#!/usr/bin/env bash
set -euo pipefail

# prek kept the repo's pre-migration commit hook as pre-commit.legacy and runs
# it beside the managed hook. The legacy wrapper runs the suite with the
# caller's PATH, so a caller without util-linux fails the Git hook output
# tests, and every commit pays for the suite twice. Activation removes it,
# because the managed hook already runs the same precommit with the nix bin
# PATH. A legacy file that carries anything but the known wrapper stays.
hooks_dir="$(git rev-parse --git-path hooks 2>/dev/null)" || exit 0
legacy="${hooks_dir}/pre-commit.legacy"
[ -f "$legacy" ] || exit 0
known_wrapper='#!/usr/bin/env sh
# Installed by tickets flake.nix
exec deno task precommit'
if [ "$(cat "$legacy")" = "$known_wrapper" ]; then
  rm "$legacy" || echo "tickets: could not remove $legacy" >&2
fi
