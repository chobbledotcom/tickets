#!/usr/bin/env bash

# shellcheck source=/dev/null
source @runtimeSetup@

# Prek captures both streams, so callers see hook output only once the run
# ends. prek's own stdout names the caller: a person's terminal gets live
# output there; captured callers (CI, agents) keep output in their pipes.
if { exec 3<>"/proc/$PPID/fd/1"; } 2>/dev/null; then
  if [ -t 3 ]; then
    if { exec >/dev/tty; } 2>/dev/null; then
      exec 2>&1
    fi
  fi
  exec 3>&-
fi

exec deno task precommit
