#!/bin/sh
set -e

# The data volume may be owned by another uid; git refuses to touch it otherwise.
git config --global --add safe.directory '*'

# Clone/bootstrap happen inside the server boot (ensureClone) — easier to test.
exec node server/index.js
