FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0

EXPOSE 10000

CMD ["node", "server.js"]
