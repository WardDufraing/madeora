#!/usr/bin/env bash
# SessionStart: make the Graphify CLI available and refresh the local code graph.
# Code-only and offline (no LLM, no API key). Never blocks session start.
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
if ! command -v graphify >/dev/null 2>&1; then
  command -v uv >/dev/null 2>&1 && uv tool install "graphifyy==0.9.93" >&2 || true
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v graphify >/dev/null 2>&1 || exit 0
GRAPHIFY_BACKEND=none graphify update . >&2 || true
exit 0
