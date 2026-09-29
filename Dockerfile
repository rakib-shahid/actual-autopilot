FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Budget cache and run state live here; mount a volume so restarts are fast.
VOLUME ["/data"]
ENV DATA_DIR=/data

USER node
CMD ["node", "src/index.js"]
