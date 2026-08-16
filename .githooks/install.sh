#!/bin/sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
hooks=$(git rev-parse --git-path hooks); mkdir -p "$hooks"
cp "$here/pre-commit" "$hooks/pre-commit"; chmod +x "$hooks/pre-commit"
echo "Installed pre-commit guardrail: code changes now require a version bump."
