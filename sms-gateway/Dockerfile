FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 4330

CMD ["node", "server.js"]
