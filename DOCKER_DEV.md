# Local Docker Development Guide

## Quick Start

### Prerequisites
- Docker & Docker Compose installed
- Azure subscription with permissions to create apps
- GitHub credentials (for pushing changes)

### 1. Set up Environment Variables

```bash
cp .env.example .env
```

Then edit `.env` with your Azure credentials:
```env
AZURE_TENANT_ID=62c0cb46-1fcc-4c79-ba1b-d7d9fdfbaa68
AZURE_CLIENT_ID=b5fd325c-2a69-40bd-bb31-06d0d3a501a4
AZURE_CLIENT_SECRET=your-actual-secret
AZURE_SUBSCRIPTION_ID=31613fe0-1e9b-4a97-b771-dc48fbaa0fbb
COSMOS_ENDPOINT=http://cosmos:8081
```

> **Security**: Never commit `.env` to git. It's in `.gitignore`.

### 2. Start the Application

**Option A: Full stack with Cosmos DB emulator**
```bash
docker-compose up --build
```
- Functions API runs on `http://localhost:7071`
- Frontend available at `http://localhost:7071` (served by Functions)
- Cosmos DB emulator on `localhost:8081`

**Option B: API only (use cloud Cosmos DB)**
```bash
docker-compose up --build app
```

### 3. Verify It's Running

```bash
# Check container status
docker-compose ps

# View logs
docker-compose logs -f app

# Test API health
curl http://localhost:7071/api/health
```

### 4. Access the Application

1. Navigate to `http://localhost:7071` in your browser
2. You'll be redirected to AAD login (configure SSO in `staticwebapp.config.json`)
3. After login, the dashboard loads

## Development Workflow

### Hot Reload
The `api` directory is mounted as a volume, so changes to Azure Functions are picked up automatically:

```bash
# While container is running, edit a function:
code api/GetRequests/index.js
# Changes are reflected immediately — no rebuild needed
```

### Rebuild After Dependencies Change
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up
```

### Debug Logs
```bash
# Stream all logs
docker-compose logs -f

# Only app logs
docker-compose logs -f app

# Only cosmos logs
docker-compose logs -f cosmos
```

## Testing the API

### List Requests
```bash
curl -X GET http://localhost:7071/api/GetRequests
```

### Submit a New Request
```bash
curl -X POST http://localhost:7071/api/SubmitRequest \
  -H "Content-Type: application/json" \
  -d '{
    "subscriptionId": "31613fe0-1e9b-4a97-b771-dc48fbaa0fbb",
    "resourceGroup": "rg-test",
    "deploymentName": "test-deployment",
    "templateUri": "https://example.com/template.json",
    "parameters": {}
  }'
```

## Cosmos DB Emulator

The emulator runs in the `cosmos` container and stores data in a local volume (`cosmos-data`).

### Connect to Cosmos Emulator
```bash
# From inside the app container, use:
COSMOS_ENDPOINT=http://cosmos:8081
COSMOS_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLMQA0ftQ0PxopQX7ojusAsy/JRO7x6pFd8V6v4nKvEJCvL8M2vK9FQ==
```

### Reset Data
```bash
docker volume rm azure-deployment-retry_cosmos-data
docker-compose up cosmos
```

## Troubleshooting

### "Connection refused" on localhost:7071
```bash
# Ensure container is running
docker-compose ps

# Check if port is in use
netstat -tulnp | grep 7071

# Restart
docker-compose restart app
```

### "AADSTS700016" auth error
This means the Azure app registration is still pointing to a different tenant. Update `.env`:
```env
AZURE_TENANT_ID=<your-actual-tenant>
AZURE_CLIENT_ID=<your-actual-app-id>
```

Then rebuild:
```bash
docker-compose up --build
```

### Cosmos DB connection timeout
The emulator needs time to initialize:
```bash
# Wait for it to be ready
docker-compose logs cosmos | grep "Emulator started"

# Then restart the app container
docker-compose restart app
```

## Next Steps

### Push to GitHub
```bash
git add Dockerfile docker-compose.yml .env.example DOCKER_DEV.md
git commit -m "feat: Add Docker local development setup"
git push origin docker-local-dev
```

### Create a Pull Request
Then open a PR on GitHub to merge `docker-local-dev` → `main`.

### Production Notes
- **Don't use Cosmos emulator in production** — it's dev-only
- For prod, set `COSMOS_ENDPOINT` to your real Cosmos DB endpoint
- Use managed identity (AZURE_FEDERATED_TOKEN_FILE) instead of secrets in prod
- Consider using Azure Container Registry (ACR) for image storage
