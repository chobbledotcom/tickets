#!/usr/bin/env nix-shell
#!nix-shell -i bash -p buildah podman openssl

set -euo pipefail

IMAGE="tickets"
CONTAINER="tickets"
PORT="${PORT:-3000}"
VOLUME="tickets-data"

# Build the image
echo "Building $IMAGE image..."
buildah bud -t "$IMAGE" .

# Stop existing container if running
if podman container exists "$CONTAINER" 2>/dev/null; then
  echo "Stopping existing $CONTAINER container..."
  podman stop "$CONTAINER"
  podman rm "$CONTAINER"
fi

# Create volume if it doesn't exist
podman volume exists "$VOLUME" 2>/dev/null || podman volume create "$VOLUME"

# Require DB_ENCRYPTION_KEY to be set explicitly to prevent accidental key generation
if [ -z "${DB_ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: DB_ENCRYPTION_KEY is not set."
  echo "Generate one with: openssl rand -base64 32"
  echo "Then export it: export DB_ENCRYPTION_KEY='<your-key>'"
  exit 1
fi

echo "Starting $CONTAINER on port $PORT..."
podman run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:3000" \
  -v "$VOLUME:/data" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  -e DB_ENCRYPTION_KEY="${DB_ENCRYPTION_KEY}" \
  "$IMAGE"

echo "Container running: http://localhost:$PORT"
echo "Logs: podman logs -f $CONTAINER"
