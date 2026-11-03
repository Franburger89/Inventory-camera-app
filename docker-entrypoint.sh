#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/sessions"

# Railway volumes are mounted as root. Hand the mount to the node user, then
# drop privileges. chown is limited to the mount root so restarts stay fast.
if [ "$(id -u)" = "0" ]; then
  chown node:node "$DATA_DIR" "$DATA_DIR/sessions"
  exec su-exec node "$@"
fi

exec "$@"
