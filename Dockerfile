# Portable container image (for Render "Docker" runtime, Fly.io, Railway, a VPS…).
# Render can also deploy without this using the native Node runtime (see render.yaml).
FROM node:20-slim AS deps
WORKDIR /app
# Build tools for native modules (better-sqlite3) in case a prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# Data directory (mount a persistent volume here in production).
RUN mkdir -p /data && chown -R node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
ENV DB_FILE=/data/udc.db
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
