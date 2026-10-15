# Multi-stage production container for AIRA Specialist Worker
# Stage 1: Build & Dependencies
FROM node:24-slim AS builder

WORKDIR /app

# Install system build dependencies if necessary
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY packages/ ./packages/
COPY apps/specialist-worker/ ./apps/specialist-worker/
COPY tsconfig.json ./

# Stage 2: Runtime Minimal Non-Root Image
FROM node:24-slim AS runner

WORKDIR /app

# Install dumb-init and curl for signal handling and health probes
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create secure non-root system user and group
RUN groupadd -g 10001 aira && \
    useradd -u 10001 -g aira -s /bin/bash -m aira

# Copy dependencies and application from builder
COPY --from=builder --chown=aira:aira /app/node_modules ./node_modules
COPY --from=builder --chown=aira:aira /app/packages ./packages
COPY --from=builder --chown=aira:aira /app/apps/specialist-worker ./apps/specialist-worker
COPY --from=builder --chown=aira:aira /app/package.json ./package.json
COPY --from=builder --chown=aira:aira /app/tsconfig.json ./tsconfig.json

# Environment configuration
ENV NODE_ENV=production \
    AIRA_SPECIALIST_WORKER_PROCESS=true \
    AIRA_SPECIALIST_WORKER_ENABLED=true \
    AIRA_SPECIALIST_DELEGATION_ENABLED=true \
    PORT=8080

# Expose HTTP health probe port
EXPOSE 8080

# Switch to non-root user
USER aira

# Configure container healthcheck against HTTP liveness endpoint
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "apps/specialist-worker/src/index.ts"]
