#!/usr/bin/env bash
set -euo pipefail

# Local development uses the filesystem for uploads unless an explicit value
# wins. An empty value turns storage off.
export LOCAL_STORAGE_PATH="${LOCAL_STORAGE_PATH-.storage}"

# Local development reports each recorded guide video, so the admin camera link
# works without a CDN publish. An explicit GUIDE_VIDEOS wins.
if [ -z "${GUIDE_VIDEOS:-}" ] && [ -d reports/guides ]; then
  videos=""
  for video in reports/guides/*/guide.mp4; do
    [ -f "$video" ] || continue
    slug="$(basename "$(dirname "$video")")"
    # Only a guide slug can name a local video. Skip any other directory.
    case "$slug" in
      *[!a-z0-9-]*) continue ;;
    esac
    videos="${videos:+$videos,}\"$slug\":{\"video\":\"/guide-videos/$slug\"}"
  done
  if [ -n "$videos" ]; then
    export GUIDE_VIDEOS="{$videos}"
  fi
fi

exec "$@"
