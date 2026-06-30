# Watapp WhatsApp server (Baileys + Express)
FROM node:20-slim

WORKDIR /app

# proxychains-ng — route all outbound traffic via a SOCKS proxy (residential IP) at
# the process level when PROXY_URL is set (see start.sh).
RUN apt-get update && apt-get install -y --no-install-recommends proxychains4 \
  && rm -rf /var/lib/apt/lists/*

# Install production deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (data/ and sessions/ are bind-mounted at runtime — see .dockerignore)
COPY . .

ENV NODE_ENV=production
EXPOSE 10001
CMD ["sh", "start.sh"]
