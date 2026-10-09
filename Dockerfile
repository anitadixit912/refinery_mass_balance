FROM node:22-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data && chmod +x /app/start.sh

EXPOSE 4004

CMD ["/app/start.sh"]
