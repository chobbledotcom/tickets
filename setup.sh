#!/bin/bash
set -euo pipefail

DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"

if command -v deno >/dev/null 2>&1; then
  DENO_BIN="$(command -v deno)"
  echo "Using existing Deno at: $DENO_BIN"
elif [[ -x "$DENO_BIN" ]]; then
  echo "Using existing Deno at: $DENO_BIN"
else
  echo "Installing Deno..."
  INSTALL_SOURCES=(
    "https://deno.land/install.sh"
    "https://raw.githubusercontent.com/denoland/deno_install/main/install.sh"
  )

  install_success=false
  for source in "${INSTALL_SOURCES[@]}"; do
    echo "  trying $source"
    if curl -fsSL "$source" | DENO_INSTALL="$DENO_INSTALL" sh; then
      install_success=true
      break
    fi
  done

  if [ "$install_success" != true ]; then
    echo "Failed to install Deno from known install sources." >&2
    exit 1
  fi
fi

# Add Deno to PATH for this session
export DENO_INSTALL
export PATH="$DENO_INSTALL/bin:$PATH"
export DENO_TLS_CA_STORE=system

# Ensure "deno" resolves after install, even if it is only in DENO_INSTALL/bin.
if ! command -v deno >/dev/null 2>&1; then
  alias deno="$DENO_BIN"
fi

if ! command -v deno >/dev/null 2>&1; then
  echo "Deno installer completed but deno binary was not found on PATH." >&2
  exit 1
fi

echo ""
echo "Deno installed successfully!"
"$DENO_BIN" --version

echo ""
echo "Caching dependencies..."
"$DENO_BIN" install

RUN_PRECOMMIT="${RUN_PRECOMMIT:-0}"
if [[ "$RUN_PRECOMMIT" == "1" ]]; then
  echo ""
  echo "Running precommit checks..."
  "$DENO_BIN" task precommit
else
  echo ""
  echo "Skipping precommit checks by default in this environment."
  echo "Set RUN_PRECOMMIT=1 to run the full precommit suite."
fi
