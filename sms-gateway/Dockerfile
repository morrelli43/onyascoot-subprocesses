FROM node:24-alpine AS builder

RUN apk upgrade --no-cache
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --production

FROM node:24-alpine

RUN apk upgrade --no-cache

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY server.js db.js ./

EXPOSE 4330

CMD ["node", "server.js"]
