# Watapp WhatsApp server (Baileys + Express)
FROM node:20-slim

WORKDIR /app

# Install production deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code (data/ and sessions/ are bind-mounted at runtime — see .dockerignore)
COPY . .

ENV NODE_ENV=production
EXPOSE 10001
CMD ["node", "index.js"]
