FROM node:20-alpine

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

# Copy root package.json for the start script
COPY package.json ./

# Copy relay and install dependencies
COPY relay/ relay/
RUN cd relay && npm install --production

# Copy skill (needed for shared libs if any)
COPY skill/ skill/
RUN cd skill && npm install --production

EXPOSE 8080

CMD ["npm", "start"]
