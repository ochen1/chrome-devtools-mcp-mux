#!/bin/bash
# Wrap the system chromium with flags required in sandboxed containers.
exec "${DEMO_CHROMIUM:-/usr/bin/chromium}" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  "$@"
