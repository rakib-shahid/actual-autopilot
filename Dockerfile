FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Budget cache and run state live here; mount a volume so restarts are fast.
RUN mkdir -p /data /import /done /backups && chown node:node /data /import /done /backups
VOLUME ["/data"]
ENV DATA_DIR=/data

EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
