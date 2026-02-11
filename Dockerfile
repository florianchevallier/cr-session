# syntax=docker/dockerfile:1.7

FROM node:22-slim AS deps
WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

RUN npm ci --ignore-scripts
# Rebuild native modules for Linux
RUN npm rebuild better-sqlite3

FROM deps AS builder
WORKDIR /app

COPY backend ./backend
COPY frontend ./frontend

RUN npm run build -w backend && npm run build -w frontend

# TypeScript does not emit markdown prompt files; copy bundled universes for runtime.
RUN mkdir -p backend/dist/config \
  && cp -R backend/src/config/universes backend/dist/config/universes

RUN npm prune --omit=dev

FROM node:22-slim AS prod
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/backend/data/editor-drafts /app/backend/data/universes

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "backend/dist/index.js"]
