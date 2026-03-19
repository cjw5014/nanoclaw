#!/bin/bash
# Build the NanoClaw game tester container image.
# Requires nanoclaw-agent:latest to exist — run ./build.sh first if needed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-game-tester"
TAG="${1:-latest}"
GODOT_VERSION="${GODOT_VERSION:-4.6}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Ensure base image exists
if ! ${CONTAINER_RUNTIME} image inspect nanoclaw-agent:latest &>/dev/null; then
  echo "Base image nanoclaw-agent:latest not found. Building it first..."
  bash "$SCRIPT_DIR/build.sh"
fi

echo "Building NanoClaw game tester image..."
echo "Image: ${IMAGE_NAME}:${TAG}"
echo "Godot: ${GODOT_VERSION}"

${CONTAINER_RUNTIME} build \
  -f Dockerfile.game-tester \
  --build-arg GODOT_VERSION="${GODOT_VERSION}" \
  -t "${IMAGE_NAME}:${TAG}" \
  .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Register a game-test group with:"
echo '  containerConfig: { "image": "nanoclaw-game-tester:latest", "additionalMounts": [{ "hostPath": "~/your-game", "containerPath": "/workspace/game" }] }'
