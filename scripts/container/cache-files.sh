#!/usr/bin/env bash
# shellcheck disable=SC2154 # Nix supplies out.

mkdir -p "$out/deno-cache"
cp -r "$CACHE_SOURCE/." "$out/deno-cache/"
chmod -R ugo+rX "$out"
