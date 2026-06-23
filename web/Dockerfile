# Watapp dashboard (Next.js, standalone production build)
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime image ───────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10000
ENV HOSTNAME=0.0.0.0

# Standalone server + static assets + public/
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 10000
CMD ["node", "server.js"]
