#!/usr/bin/env bash
# Shared dependency install for CI and the container image build.
#
# --frozen makes a dependency change that did not update deno.lock fail here.
# The install does not resolve a new tree silently.
#
# The allowlist runs npm lifecycle scripts only for the packages that need
# them. It must match the packages deno.lock records with "scripts": true,
# sorted. When a dependency adds a script-bearing package, name it here too.
# Deno runs lifecycle scripts only with a node_modules directory. The global
# module cache runs none today. The list holds the policy for a future
# node_modules setup. The test at test/scripts/ci/deno-install.test.ts
# enforces the match.
set -euo pipefail

deno install \
  --frozen \
  --allow-scripts=npm:@parcel/watcher,npm:esbuild,npm:fsevents,npm:sharp
