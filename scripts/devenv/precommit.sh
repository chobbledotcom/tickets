#!/usr/bin/env bash

# shellcheck source=/dev/null
source @runtimeSetup@
exec deno task precommit
