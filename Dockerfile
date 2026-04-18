FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    TMP_DIR=/app/downloads \
    YTDLP_PATH=/usr/local/bin/yt-dlp

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl \
    && python3 -m pip install --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/downloads

EXPOSE 3000
CMD ["npm", "start"]
