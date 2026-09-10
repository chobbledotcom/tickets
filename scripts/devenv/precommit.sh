#!/usr/bin/env bash

# shellcheck source=/dev/null
source @runtimeSetup@

# Prek captures both streams. Keep live progress when a terminal is available.
if { exec >/dev/tty; } 2>/dev/null; then
  exec 2>&1
fi

exec deno task precommit
