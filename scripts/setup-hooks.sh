#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .githooks
if [ ! -f .githooks/pre-commit ]; then
  echo "ERROR: .githooks/pre-commit not found." >&2
  exit 1
fi
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
echo "Git hooks installed: core.hooksPath=.githooks"
echo "Pre-commit will block commits touching: logs/**, memory/**/textual_memory.json, node_modules/, dist/, data/, backup/, .memos/, PR_BODY.md, *.db/*.sqlite/*.sqlite3/*.bundle, and .env files (except .env.example)."
