#!/usr/bin/env bash
set -euo pipefail

stream="$(devenv build outputs.tickets-image | jq -r '."outputs.tickets-image"')"
loader="$(command -v podman || command -v docker)"
"$stream" | "$loader" load
