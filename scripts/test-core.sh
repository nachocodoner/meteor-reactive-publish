#!/usr/bin/env bash
set -euo pipefail

# Keep core and its tests untouched. Select a clean checkout explicitly.
exec node "$(dirname "$0")/test-core.mjs" "$@"
