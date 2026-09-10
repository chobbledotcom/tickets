#!/usr/bin/env bash

# The database FFI needs libstdc++ in shells and Git hooks.
library_path="@libraryPath@"
if [ -n "$library_path" ]; then
  export LD_LIBRARY_PATH="$library_path:${LD_LIBRARY_PATH:-}"
fi
