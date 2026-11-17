#!/usr/bin/env bash
set -euo pipefail

# Local development uses the filesystem for uploads unless an explicit value
# wins. An empty value turns storage off.
export LOCAL_STORAGE_PATH="${LOCAL_STORAGE_PATH-.storage}"

exec "$@"
