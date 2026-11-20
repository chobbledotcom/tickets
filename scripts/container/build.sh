#!/usr/bin/env bash
set -euo pipefail

# These steps need network access outside the Nix sandbox.
bash scripts/ci/deno-install.sh
deno task build:static
mkdir -p .container-work
# The cache must not extend the tree that the frozen install verified.
DENO_DIR="$PWD/.container-work/deno-cache" deno cache src/index.ts --frozen

# Runtime packages do not need their nested Biome configs.
find .container-work/deno-cache -name biome.json -delete

# The shell exports LD_LIBRARY_PATH for the database FFI. That export shadows
# the C++ runtime the devenv CLI carries, so the CLI must run without it.
env -u LD_LIBRARY_PATH devenv build outputs.tickets-image
