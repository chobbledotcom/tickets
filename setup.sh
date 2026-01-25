#!/bin/bash
set -e

echo "Installing Deno..."
curl -fsSL https://deno.land/install.sh | sh

# Add Deno to PATH for this session
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
export DENO_TLS_CA_STORE=system

echo ""
echo "Deno installed successfully!"
deno --version

echo ""
echo "Caching dependencies..."
deno install

echo ""
echo "Running precommit checks..."
deno task precommit
