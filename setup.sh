#!/bin/bash
set -euo pipefail

echo "Installing Deno..."
INSTALL_SOURCES=(
  "https://deno.land/install.sh"
  "https://raw.githubusercontent.com/denoland/deno_install/main/install.sh"
)

install_success=false
for source in "${INSTALL_SOURCES[@]}"; do
  echo "  trying $source"
  if curl -fsSL "$source" | sh; then
    install_success=true
    break
  fi
done

if [ "$install_success" != true ]; then
  echo "Failed to install Deno from known install sources." >&2
  exit 1
fi

# Add Deno to PATH for this session
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
export DENO_TLS_CA_STORE=system

if ! command -v deno >/dev/null 2>&1; then
  echo "Deno installer completed but deno binary was not found on PATH." >&2
  exit 1
fi

echo ""
echo "Deno installed successfully!"
deno --version

echo ""
echo "Caching dependencies..."
deno install

echo ""
echo "Running precommit checks..."
deno task precommit
