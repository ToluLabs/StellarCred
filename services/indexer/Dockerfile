FROM node:20-slim

WORKDIR /app

# Copy package files and install all dependencies (including dev for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and TypeScript config
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript source
RUN npm run build

# Use the compiled entrypoint
EXPOSE 3001

CMD ["node", "dist/index.js"]
