FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    mkvtoolnix aria2 megatools ffmpeg zip python3 python3-pip ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages mega.py gdown \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.mjs"]
