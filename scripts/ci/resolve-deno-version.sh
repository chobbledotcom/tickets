#!/usr/bin/env bash
# Prints "version=<x>" to $GITHUB_OUTPUT for the Deno cache key. Runs inside
# the setup-devenv action, before the dependency cache exists, so it is plain
# bash rather than a Deno task. A cold eval can rarely fail on an ephemeral
# runner with `path '...' is not valid` while nix stores a file mid-eval, so
# the loop retries. A broken pin fails every attempt. A torn cold eval does not
# survive a second one. RESOLVE_RETRY_SLEEP exists for the tests.

set -euo pipefail

profile=""
if [ -n "${1:-}" ]; then
  profile="--profile $1"
fi

version=""
for attempt in 1 2 3; do
  if version="$(devenv $profile shell -- deno --version | sed -n 's/^deno \([^ ]*\).*/\1/p')" && [ -n "$version" ]; then
    break
  fi
  # A failed pipeline can still print a version line first. Drop it, so the
  # emptiness check below never counts a failed eval as a resolved version.
  version=""
  echo "resolve attempt $attempt failed; retrying" >&2
  if [ "$attempt" -lt 3 ]; then
    sleep "${RESOLVE_RETRY_SLEEP:-5}"
  fi
done

test -n "$version"
echo "version=$version" >> "$GITHUB_OUTPUT"
