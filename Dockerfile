# Multi-stage build for Azure Deployment Retry Platform
# Stage 1: Build frontend
FROM node:18-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend .

# Stage 2: Build API
FROM node:18-alpine AS api-builder
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api .

# Stage 3: Runtime
FROM node:18-alpine
WORKDIR /app

# Install curl and Azure Functions Core Tools dependencies
RUN apk add --no-cache curl bash

# Install Azure Functions Core Tools
RUN npm install -g azure-functions-core-tools@4 --unsafe-perm

# Copy API
COPY --from=api-builder /app/api /app/api
WORKDIR /app/api

# Copy frontend to serve as static files
COPY --from=frontend-builder /app/frontend /app/api/public

# Expose port (Functions host runs on 7071 by default)
EXPOSE 7071

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:7071/api/health 2>/dev/null || exit 1

# Set up environment
ENV FUNCTIONS_WORKER_RUNTIME=node
ENV AzureWebJobsScriptRoot=/app/api
ENV AzureFunctionsJobHost__Logging__Console__IsEnabled=true

# Start Azure Functions runtime
CMD ["func", "start", "--port", "7071"]
