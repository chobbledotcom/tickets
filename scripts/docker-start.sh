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

echo "Starting $CONTAINER on port $PORT..."
podman run -d \
  --name "$CONTAINER" \
  -p "$PORT:3000" \
  -v "$VOLUME:/data" \
  -e DB_ENCRYPTION_KEY="${DB_ENCRYPTION_KEY:-$(openssl rand -base64 32)}" \
  "$IMAGE"

echo "Container running: http://localhost:$PORT"
echo "Logs: podman logs -f $CONTAINER"
