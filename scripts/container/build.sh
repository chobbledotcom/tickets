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
devenv build outputs.tickets-image
