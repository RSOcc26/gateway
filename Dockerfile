# syntax=docker/dockerfile:1
# Production image: runtime dependencies only, non-root, read-only friendly.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Numeric user, so Kubernetes runAsNonRoot can verify it (the "node" user of the base image)
USER 1000:1000
EXPOSE 8080
CMD ["node", "src/server.js"]
