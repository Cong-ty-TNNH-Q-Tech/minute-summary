FROM node:18

# Build tools cho whisper.cpp + ffmpeg cho audio conversion
RUN apt-get update && apt-get install -y \
    build-essential \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /bot

COPY package*.json ./

RUN npm install

COPY . .

CMD ["npm", "start"]
