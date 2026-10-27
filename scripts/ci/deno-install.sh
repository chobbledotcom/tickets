#!/usr/bin/env bash
# Shared dependency install for CI and the container image build.
#
# --frozen makes a dependency change that did not update deno.lock fail here.
# The install does not resolve a new tree silently.
#
# The allowlist runs npm lifecycle scripts only for the packages that need
# them. Every listed package has a "scripts": true entry in deno.lock. When a
# dependency adds a script-bearing package, name it here too. The test at
# test/scripts/ci/deno-install.test.ts enforces the match.
set -euo pipefail

deno install \
  --frozen \
  --allow-scripts=npm:esbuild,npm:sharp,npm:@parcel/watcher,npm:fsevents
