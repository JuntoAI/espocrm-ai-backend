# ── Stage 1: Build MCP server ────────────────────────────────
FROM node:20-alpine AS mcp-builder

WORKDIR /mcp
COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY mcp-server/tsconfig.json ./
COPY mcp-server/src/ ./src/
RUN npm run build

# ── Stage 2: Build AI Backend ───────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 3: Production image ───────────────────────────────
FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Install AI Backend production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy AI Backend compiled code
COPY --from=builder /app/dist ./dist

# Copy MCP server (compiled + production deps)
COPY mcp-server/package.json mcp-server/package-lock.json* ./mcp-server/
RUN cd mcp-server && npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=mcp-builder /mcp/build ./mcp-server/build

# Set MCP server path so AI Backend finds it at startup
ENV MCP_SERVER_PATH=/app/mcp-server/build/index.js

RUN mkdir -p /tmp/uploads && chown appuser:appgroup /tmp/uploads
RUN mkdir -p /app/logs && chown appuser:appgroup /app/logs
RUN mkdir -p /app/mcp-server/logs && chown appuser:appgroup /app/mcp-server/logs
RUN mkdir -p /data/knowledge/global /data/knowledge/users && chown -R appuser:appgroup /data/knowledge

USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
