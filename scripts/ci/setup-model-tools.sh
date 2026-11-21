#!/usr/bin/env bash
# Install the tools that one model check needs, without devenv: Deno, Java,
# and the Apalache checker. The model jobs use this instead of the devenv
# setup, which takes longer than most checks.
#
# DENO_VERSION must match `denoVersion` in devenv.nix. The Apalache version
# and hash must match the `apalacheArchive` in devenv.nix. The test at
# test/scripts/ci/setup-model-tools.test.ts enforces both.
set -euo pipefail

DENO_VERSION="2.5.6"
DENO_SHA256="fd4f6abc1b6a134fa9a4dba56519f1631f44c88e04e4e3e9a8ff5975dfa66e1a"
APALACHE_VERSION="0.62.1"
APALACHE_SHA256="93fef2f381d30465eff906a2d6afa3358cb2c9adf6a8aad3bec0ded4f45432bb"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "Model tools support only Linux x86_64." >&2
  exit 1
fi

tools="${RUNNER_TEMP:?RUNNER_TEMP must name a writable directory}/model-tools"
mkdir -p "$tools/bin"

# Download one file and stop unless its SHA-256 hash matches.
fetch() {
  local url="$1" hash="$2" file="$3"
  curl --fail --silent --show-error --location --retry 3 --output "$file" "$url"
  echo "$hash  $file" | sha256sum --check --quiet
}

fetch \
  "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
  "$DENO_SHA256" "$tools/deno.zip"
unzip -q -o "$tools/deno.zip" -d "$tools/bin"

fetch \
  "https://github.com/apalache-mc/apalache/releases/download/v${APALACHE_VERSION}/apalache-${APALACHE_VERSION}.tgz" \
  "$APALACHE_SHA256" "$tools/apalache.tgz"
tar -xOzf "$tools/apalache.tgz" "apalache-${APALACHE_VERSION}/lib/apalache.jar" \
  >"$tools/apalache.jar"

# Apalache needs Java 21. The runner default can be older, so use the image
# copy of Java 21 and install a headless runtime only when the image has none.
java_bin=""
if [ -n "${JAVA_HOME_21_X64:-}" ] && [ -x "$JAVA_HOME_21_X64/bin/java" ]; then
  java_bin="$JAVA_HOME_21_X64/bin/java"
elif [ -x /usr/lib/jvm/java-21-openjdk-amd64/bin/java ]; then
  java_bin=/usr/lib/jvm/java-21-openjdk-amd64/bin/java
else
  sudo -n apt-get update --quiet
  sudo -n apt-get install --yes --no-install-recommends openjdk-21-jre-headless
  java_bin=/usr/lib/jvm/java-21-openjdk-amd64/bin/java
fi

# The checker command is the one that devenv.nix names.
printf '#!/usr/bin/env bash\nexec "%s" -jar "%s" "$@"\n' "$java_bin" "$tools/apalache.jar" \
  >"$tools/bin/apalache-mc"
chmod +x "$tools/bin/apalache-mc"

export PATH="$tools/bin:$PATH"
if [ "$(deno --version | head -n 1 | cut -d ' ' -f 2)" != "$DENO_VERSION" ]; then
  echo "The installed Deno is not version $DENO_VERSION." >&2
  exit 1
fi
apalache-mc version

echo "$tools/bin" >>"${GITHUB_PATH:?GITHUB_PATH must name the path file}"
echo "deno-version=$DENO_VERSION" >>"${GITHUB_OUTPUT:?GITHUB_OUTPUT must name the output file}"
