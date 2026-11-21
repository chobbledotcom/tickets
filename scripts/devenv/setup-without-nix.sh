#!/usr/bin/env bash
# Install the pinned toolchain without Nix or devenv, for a Linux machine that
# cannot run `devenv shell`. An example is a sandbox whose network policy blocks
# the pinned nixpkgs download. The script reads each version from the file that
# pins it, so no second copy can drift:
#
#   Deno         devenv.nix (denoVersion)
#   Biome        biome.json ($schema)
#   stripe-mock  scripts/stripe-mock/install.ts (STRIPE_MOCK_VERSION)
#
# The script is safe to run again. It leaves out Apalache and Java (the machine
# safety models), Chromium (the browser contract tests), and the Git hook.
#
#   bash scripts/devenv/setup-without-nix.sh
#   export PATH="$HOME/.local/bin:$PATH"
#
# TICKETS_TOOLS_DIR changes where Deno and Biome go. `--print-pins` prints the
# versions and stops.

set -euo pipefail

root="${TICKETS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
tools_dir="${TICKETS_TOOLS_DIR:-$HOME/.local/bin}"

fail() {
  echo "setup-without-nix: $*" >&2
  exit 1
}

# Print the first capture of a sed expression over a file, or fail.
pin() {
  local name="$1" file="$2" expression="$3" value
  value="$(sed -n "$expression" "$root/$file" | head -n 1)"
  [ -n "$value" ] || fail "no $name pin in $file"
  printf '%s' "$value"
}

deno_version="$(pin Deno devenv.nix 's/.*denoVersion = "\([^"]*\)".*/\1/p')"
biome_version="$(pin Biome biome.json 's#.*biomejs.dev/schemas/\([0-9.]*\)/schema.json.*#\1#p')"
stripe_mock_version="$(pin stripe-mock scripts/stripe-mock/install.ts \
  's/^export const STRIPE_MOCK_VERSION = "\([^"]*\)".*/\1/p')"

case "${1:-}" in
  "") ;;
  --print-pins)
    printf 'deno=%s\nbiome=%s\nstripe-mock=%s\n' \
      "$deno_version" "$biome_version" "$stripe_mock_version"
    exit 0
    ;;
  *)
    echo "usage: setup-without-nix.sh [--print-pins]" >&2
    exit 2
    ;;
esac

[ "$(uname -s)" = "Linux" ] || fail "this script supports Linux only"
case "$(uname -m)" in
  x86_64) deno_arch="x86_64" biome_arch="x64" stripe_arch="amd64" ;;
  aarch64 | arm64) deno_arch="aarch64" biome_arch="arm64" stripe_arch="arm64" ;;
  *) fail "unsupported machine type $(uname -m)" ;;
esac

for tool in curl tar unzip; do
  command -v "$tool" > /dev/null || fail "$tool is missing. Run: apt-get install -y $tool"
done

mkdir -p "$tools_dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Print the version that an installed tool reports, or nothing.
version_of() {
  "$1" --version 2> /dev/null | sed -n 's/^[^0-9]*\([0-9][0-9.]*\).*/\1/p' | head -n 1
}

install_deno() {
  if [ "$(version_of "$tools_dir/deno")" = "$deno_version" ]; then
    echo "Deno $deno_version is installed."
    return
  fi
  echo "Installing Deno $deno_version."
  curl -fsSL -o "$work/deno.zip" \
    "https://github.com/denoland/deno/releases/download/v$deno_version/deno-$deno_arch-unknown-linux-gnu.zip"
  unzip -oq "$work/deno.zip" -d "$tools_dir" deno
  chmod +x "$tools_dir/deno"
}

install_biome() {
  if [ "$(version_of "$tools_dir/biome")" = "$biome_version" ]; then
    echo "Biome $biome_version is installed."
    return
  fi
  echo "Installing Biome $biome_version."
  curl -fsSL -o "$work/biome.tgz" \
    "https://registry.npmjs.org/@biomejs/cli-linux-$biome_arch/-/cli-linux-$biome_arch-$biome_version.tgz"
  tar -xzf "$work/biome.tgz" -C "$work" package/biome
  install -m 755 "$work/package/biome" "$tools_dir/biome"
}

# The harness downloads the same release. Build from source with Go where that
# download is blocked.
install_stripe_mock() {
  local target="$root/.bin/stripe-mock"
  if [ -x "$target" ]; then
    echo "stripe-mock is installed."
    return
  fi
  echo "Installing stripe-mock $stripe_mock_version."
  mkdir -p "$root/.bin"
  local url="https://github.com/stripe/stripe-mock/releases/download/v$stripe_mock_version/stripe-mock_${stripe_mock_version}_linux_$stripe_arch.tar.gz"
  if curl -fsSL -o "$work/stripe-mock.tgz" "$url" 2> /dev/null; then
    tar -xzf "$work/stripe-mock.tgz" -C "$work" stripe-mock
    install -m 755 "$work/stripe-mock" "$target"
    return
  fi
  command -v go > /dev/null || fail "the stripe-mock download failed and Go is missing"
  GOBIN="$root/.bin" go install "github.com/stripe/stripe-mock@v$stripe_mock_version"
}

install_deno
install_biome
install_stripe_mock

export PATH="$tools_dir:$PATH"
(cd "$root" && bash scripts/ci/deno-install.sh)

echo
echo "Deno        $(deno --version | head -n 1)"
echo "Biome       $(biome --version)"
echo "stripe-mock $("$root/.bin/stripe-mock" --version 2>&1 | head -n 1)"
echo
echo "Add the tools to your PATH:"
echo "  export PATH=\"$tools_dir:\$PATH\""
