#!/bin/sh
# Stamps src/build-info.json with the current commit and build time, so the
# built image can report what it's actually running (see the /ping command).
# Run this before `docker compose build` — the Dockerfile has no .git to read
# from itself, on purpose (see .dockerignore).
set -eu
cd "$(dirname "$0")/.."

commit=$(git rev-parse --short HEAD)
build_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{\n  "commit": "%s",\n  "buildDate": "%s"\n}\n' "$commit" "$build_date" > src/build-info.json
