#!/usr/bin/env bash
set -euo pipefail

# The shell exports LD_LIBRARY_PATH for the database FFI. That export shadows
# the C++ runtime the devenv CLI carries, so the CLI must run without it.
stream="$(
  env -u LD_LIBRARY_PATH devenv build outputs.tickets-image \
    | jq -r '."outputs.tickets-image"'
)"
loader="$(command -v podman || command -v docker)"
"$stream" | "$loader" load
