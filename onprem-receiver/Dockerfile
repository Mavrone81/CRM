FROM node:20-slim
# Baileys pulls its libsignal dependency from git, so git + CA certs are required.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
CMD ["node", "index.mjs"]
