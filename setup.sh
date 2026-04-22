#!/bin/bash
set -e
set -o pipefail

echo "Installing Deno..."
install_deno() {
  curl -fsSL https://deno.land/install.sh | sh
  command -v "$HOME/.deno/bin/deno" >/dev/null 2>&1
}

# deno.land may be blocked in some CI/container environments; fall back to GitHub release zip
if ! install_deno; then
  echo "Primary installer failed, trying GitHub release fallback..."
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *)
      echo "Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac
  case "$OS" in
    linux) TARGET_OS="linux-gnu" ;;
    darwin) TARGET_OS="apple-darwin" ;;
    *)
      echo "Unsupported OS: $OS"
      exit 1
      ;;
  esac
  ZIP="deno-${ARCH}-unknown-${TARGET_OS}.zip"
  TMP_ZIP="$(mktemp)"
  curl -fsSL -o "$TMP_ZIP" "https://github.com/denoland/deno/releases/latest/download/${ZIP}"
  python - <<'PY' "$TMP_ZIP" "$HOME/.deno/bin"
import os
import sys
import zipfile

zip_path, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
with zipfile.ZipFile(zip_path) as zf:
    zf.extractall(out_dir)
PY
  chmod +x "$HOME/.deno/bin/deno"
  rm -f "$TMP_ZIP"
fi

# Add Deno to PATH for this session
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
export DENO_TLS_CA_STORE=system

echo ""
echo "Deno installed successfully!"
command -v deno >/dev/null 2>&1 || {
  echo "Failed to install Deno"
  exit 1
}
deno --version

echo ""
echo "Caching dependencies..."
deno install

echo ""
echo "Running precommit checks..."
deno task precommit
