# The CRM as a container, for hosting (e.g. Fly.io). Data lives on a volume at /data.
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY public ./public
COPY src ./src

# Listen on all interfaces inside the container; keep the database on the volume.
ENV PORT=8080 \
    HOST=0.0.0.0 \
    DB_FILE=/data/crm.db \
    TZ_BUSINESS=Australia/Sydney

EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
