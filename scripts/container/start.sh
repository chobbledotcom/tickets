#!/usr/bin/env bash
set -euo pipefail

if [ ! -d /deno-cache ]; then
  echo "This image was assembled without a Deno cache directory." >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /data
  # Root-squashed mounts can refuse chown but permit writes. Test access below.
  chown -R 1000:1000 /data 2>/dev/null || true
  exec setpriv --reuid=1000 --regid=1000 --clear-groups "$0" "$@"
fi

export DENO_DIR=/deno-cache
export DB_URL="${DB_URL-file:/data/tickets.db}"

# SQLite needs write access to both the database and its journal directory.
case "$DB_URL" in
  file:/*)
    db_file="${DB_URL#file:}"
    db_dir="$(dirname "$db_file")"
    if ! [ -w "$db_dir" ]; then
      echo "The local database directory $db_dir is not writable by uid $(id -u). Check the data volume's permissions." >&2
      exit 1
    fi
    if [ -e "$db_file" ] && ! [ -w "$db_file" ]; then
      echo "The local database file $db_file is not writable by uid $(id -u). Check the data volume's permissions." >&2
      exit 1
    fi
    ;;
esac

cd /app
exec deno run \
  --allow-net \
  --allow-env \
  --allow-read \
  --allow-write=/data \
  --allow-sys \
  --allow-ffi \
  src/index.ts
