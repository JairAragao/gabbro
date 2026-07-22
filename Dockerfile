# Gabbro — git-native DBML studio. Node server + git CLI, no build step.
FROM node:24-alpine

RUN apk add --no-cache git wget

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Port is configurable: runtime env PORT, build --build-arg PORT (keeps EXPOSE
# aligned for port auto-detection in Dokploy/etc).
ARG PORT=8080
ENV PORT=${PORT} \
    DATA_DIR=/data

EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["sh", "entrypoint.sh"]
