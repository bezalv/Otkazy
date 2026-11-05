# Только для локальной проверки образа. В Galaxy Dockerfile генерирует платформа.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
