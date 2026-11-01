#!/bin/sh
# Local QA only. Never connects a NiceHash account or arms live funds.
set -eu
mkdir -p .sites-runtime/go-preview
unset NICEHASH_API_KEY NICEHASH_API_SECRET NICEHASH_ORGANIZATION_ID NICEHASH_ORG_ID NICEHASH_CONFIG_FILE
export HOST=0.0.0.0
export PORT="${PORT:-4173}"
export DATA_DIR="$PWD/.sites-runtime/go-preview"
export APP_PASSWORD='go-preview-only-password-123'
export PUBLIC_URL="${PUBLIC_URL:-}"
exec ./bin/fastpool-easymining-linux-amd64
