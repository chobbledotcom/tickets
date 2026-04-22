#!/bin/bash
set -euo pipefail

DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
DENO_BIN="$DENO_INSTALL/bin/deno"

install_deno() {
  echo "Installing Deno..."

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$DENO_INSTALL" sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://deno.land/install.sh | DENO_INSTALL="$DENO_INSTALL" sh
  else
    echo "Error: neither curl nor wget is available to install Deno." >&2
    exit 1
  fi
}

if command -v deno >/dev/null 2>&1; then
  DENO_BIN="$(command -v deno)"
  echo "Using existing Deno at: $DENO_BIN"
elif [[ -x "$DENO_BIN" ]]; then
  echo "Using existing Deno at: $DENO_BIN"
else
  install_deno
fi

# Add Deno to PATH for this script.
export DENO_INSTALL
export PATH="$DENO_INSTALL/bin:$PATH"
export DENO_TLS_CA_STORE=system

# Ensure "deno" resolves after install, even if it is only in DENO_INSTALL/bin.
if ! command -v deno >/dev/null 2>&1; then
  alias deno="$DENO_BIN"
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
