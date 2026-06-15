FROM node:22-slim

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY mcp/ ./mcp/
COPY eval-queries.json ./

RUN npm run build

# Remove dev dependencies
RUN npm prune --production

ENV MCP_TRANSPORT=http
ENV MCP_PORT=3000
ENV VAULT_PATH=/vault
ENV OLLAMA_URL=http://ollama:11434

EXPOSE 3000

CMD ["node", "dist/mcp/server.js"]
