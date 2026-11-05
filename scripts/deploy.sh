#!/usr/bin/env bash
# Applies pending D1 migrations, checks that none is left, and only then deploys the Worker.
# Usage: scripts/deploy.sh <deployment>
set -euo pipefail

name="${1:?Usage: scripts/deploy.sh <deployment>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
config="../deployments/$name/wrangler.jsonc"

if [ ! -f "$root/deployments/$name/wrangler.jsonc" ]; then
  echo "Not found: deployments/$name/wrangler.jsonc" >&2
  exit 1
fi

cd "$root/worker"
pnpm exec wrangler d1 migrations apply DB --remote --config "$config"

if ! pnpm exec wrangler d1 migrations list DB --remote --config "$config" | grep -q "No migrations to apply"; then
  echo "Migrations are still pending: not deploying." >&2
  exit 1
fi

pnpm exec wrangler deploy --config "$config"
