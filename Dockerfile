# Multi-stage build for Azure Deployment Retry Platform
# Stage 1: Build API
FROM node:18-alpine AS api-builder
WORKDIR /app/api
COPY api/package*.json ./
RUN npm install
COPY api .

# Stage 2: Runtime
FROM node:18-alpine
WORKDIR /app

# Install curl
RUN apk add --no-cache curl bash

# Copy API from builder
COPY --from=api-builder /app/api /app/api
WORKDIR /app/api

# Copy static frontend to serve as static files
COPY frontend /app/api/public

# Expose port
EXPOSE 7071

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:7071/health 2>/dev/null || exit 1

# Set up environment
ENV NODE_ENV=production

# Start a simple Node server serving the static content
CMD ["node", "-e", "const http = require('http'); const fs = require('fs'); const path = require('path'); const server = http.createServer((req, res) => { console.log(`${req.method} ${req.url}`); if (req.url === '/health' || req.url === '/api/health') { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end('OK'); } else { let filePath = path.join('/app/api/public', req.url === '/' ? 'index.html' : req.url); if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) { try { res.writeHead(200); fs.createReadStream(filePath).pipe(res); } catch(e) { console.error('Stream error:', e); res.writeHead(500); res.end(); } } else { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('Not found'); } } }); server.listen(7071, '0.0.0.0', () => console.log('Server running on port 7071')); "]
