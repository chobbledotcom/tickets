#!/usr/bin/env bash
set -euo pipefail

engine="$(command -v podman || command -v docker)"
container="tickets-verify"
key="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
cleanup() { "$engine" rm -f "$container" >/dev/null 2>&1 || true; }
cleanup
trap 'cleanup' EXIT

"$engine" run -d --name "$container" -p 127.0.0.1:13000:3000 \
  -e DB_ENCRYPTION_KEY="$key" \
  ghcr.io/chobbledotcom/tickets:latest

for _ in $(seq 1 20); do
  if [ "$(curl -fsS -m 5 http://127.0.0.1:13000/health 2>/dev/null)" = "Up :)" ]; then
    echo "Server answered /health."
    home="$(curl -sS -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:13000/)"
    setup="$(curl -sS -m 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:13000/setup)"
    if [ "$home" != "503" ] || [ "$setup" != "200" ]; then
      echo "Expected home 503 (got $home) and setup 200 (got $setup). Logs:" >&2
      "$engine" logs "$container" || true
      exit 1
    fi
    echo "Server answered home 503 and setup 200."
    "$engine" stop --time 5 "$container" >/dev/null
    exit_code="$("$engine" inspect --format '{{.State.ExitCode}}' "$container")"
    if [ "$exit_code" = "137" ]; then
      echo "Container required SIGKILL after SIGTERM. Check the init process." >&2
      "$engine" logs "$container" || true
      exit 1
    fi
    echo "Container stopped on SIGTERM (exit $exit_code)."
    exit 0
  fi
  sleep 3
done

echo "The image did not serve /health within a minute. Logs:" >&2
"$engine" logs "$container" || true
exit 1
