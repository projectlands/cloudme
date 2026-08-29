# Use official lightweight Node Alpine image
FROM node:20-alpine AS runner

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Create data directories
RUN mkdir -p data/storage data/temp

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["npm", "start"]
