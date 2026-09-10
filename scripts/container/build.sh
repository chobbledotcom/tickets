#!/usr/bin/env bash
set -euo pipefail

# These steps need network access outside the Nix sandbox.
deno install --allow-scripts
deno task build:static
mkdir -p .container-work
DENO_DIR="$PWD/.container-work/deno-cache" deno cache src/index.ts

# Runtime packages do not need their nested Biome configs.
find .container-work/deno-cache -name biome.json -delete
devenv build outputs.tickets-image
