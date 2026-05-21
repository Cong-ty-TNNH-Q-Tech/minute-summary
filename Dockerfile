FROM node:18

# Build tools cho whisper.cpp + ffmpeg cho audio conversion
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /bot

COPY package*.json ./

RUN npm install && chmod +x node_modules/ffmpeg-static/ffmpeg

COPY . .

CMD ["npm", "start"]
