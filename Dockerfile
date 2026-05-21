FROM node:18

# Build tools cho whisper.cpp + ffmpeg cho audio conversion
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ffmpeg \
    libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /bot

COPY package*.json ./

RUN npm install && \
    chmod +x node_modules/ffmpeg-static/ffmpeg && \
    printf '#!/bin/sh\nexec "$(dirname "$0")/build/bin/whisper-cli" "$@"\n' \
        > node_modules/nodejs-whisper/cpp/whisper.cpp/main && \
    chmod +x node_modules/nodejs-whisper/cpp/whisper.cpp/main

COPY . .

CMD ["npm", "start"]
