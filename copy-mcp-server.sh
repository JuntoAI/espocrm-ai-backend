#!/bin/bash
# Copy MCP server source into ai-backend/mcp-server/ for Docker build.
# Docker can't access files outside the build context, so we copy them in.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_SRC="${SCRIPT_DIR}/../EspoMCP/EspoMCP"
MCP_DEST="${SCRIPT_DIR}/mcp-server"

rm -rf "$MCP_DEST"
mkdir -p "$MCP_DEST"

cp "$MCP_SRC/package.json" "$MCP_DEST/"
cp "$MCP_SRC/package-lock.json" "$MCP_DEST/" 2>/dev/null || true
cp "$MCP_SRC/tsconfig.json" "$MCP_DEST/"
cp -r "$MCP_SRC/src" "$MCP_DEST/"

echo "MCP server source copied to $MCP_DEST"
