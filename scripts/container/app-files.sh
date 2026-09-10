#!/usr/bin/env bash
# shellcheck disable=SC2154 # Nix supplies out.

# Deno requires the workspace member config even when only the server runs.
mkdir -p "$out/app/e2e-payments"
cp -r "$APP_SOURCE" "$out/app/src"
cp "$DENO_CONFIG" "$out/app/deno.json"
cp "$DENO_LOCK" "$out/app/deno.lock"
cp "$WORKSPACE_CONFIG" "$out/app/e2e-payments/deno.json"
chmod -R ugo+rX "$out"
