#!/usr/bin/env bash

deno_output="$("@deno@" --version)"
deno_line="${deno_output%%$'\n'*}"
if [[ "$deno_line" != "deno @denoVersion@ "* ]]; then
  echo "tickets requires Deno @denoVersion@, but the pinned nixpkgs provides $deno_line" >&2
  return 1
fi

printf '%s\n' \
  "tickets dev shell" \
  "  deno task start      - run server" \
  "  deno task test       - run tests" \
  "  deno task build:edge - build for edge" \
  "  deno task screenshot - capture representative pages" \
  "  deno task precommit  - typecheck + lint + cpd + build + test" \
  "  pc                   - run precommit" \
  "  container-build      - assemble the OCI runtime image" \
  "  container-load       - load the image into Docker/Podman" \
  "  container-check      - boot the image and verify it serves"

# Some npm packages carry broken Biome configs. Keep their cache outside the project.
export DENO_DIR="$HOME/.cache/deno"

# Preserve explicit values, including empty ones. Reuse the local database key.
[ -f .db-key ] || openssl rand -base64 32 > .db-key
export DB_ENCRYPTION_KEY="${DB_ENCRYPTION_KEY-$(cat .db-key)}"
export DB_URL="${DB_URL-file:./local.db}"
export PORT="${PORT-8080}"

# shellcheck source=/dev/null
source @runtimeSetup@
chromium="@chromium@"
if [ -n "$chromium" ]; then
  export CHROMIUM_EXECUTABLE="$chromium"
fi

# prek kept the repo's pre-migration commit hook beside the managed one and
# runs both, so every commit pays for the suite twice and the bare hook breaks
# when the caller's PATH lacks util-linux.
bash @legacyHookCleanup@
