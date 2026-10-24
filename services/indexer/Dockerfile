# ── Build stage ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Copy package files first for better layer caching. The committed lockfile is
# npm's (package-lock.json) — the same one CI installs from — so the image
# resolves exactly the dependency tree CI tested.
COPY package.json package-lock.json ./

# Install ALL dependencies (devDependencies included: the build needs tsc).
RUN npm ci

# Copy source code
COPY . .

# Build if present
RUN npm run build --if-present || true

# ── Production stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package.json package-lock.json ./

# Install ONLY production dependencies
RUN npm ci --omit=dev

# Copy the compiled service from the build stage
COPY --from=build /app/dist ./dist

# The default SQLITE_PATH is ./data/indexer.db, so the working directory has to
# be writable by the unprivileged user that runs the process.
RUN mkdir -p /app/data && chown -R nodejs:nodejs /app

# Security: run as non-root user
USER nodejs

# Expose the port. The default in src/config.ts is 3001, and docker-compose
# publishes the same port — the health check below must target that port too.
EXPOSE 3001

# Health check — polls the indexer's own /health endpoint. It answers 200 while
# the service is serving and 503 when the database is unreachable, so `r.ok`
# is exactly the "is this container healthy" signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the app
CMD ["node", "dist/index.js"]
