# Azure Deployment Retry Platform

Self-service portal to automatically retry Azure deployments that fail due to **capacity constraints** (GPU VMs, AI models, region quotas). Import failed deployments from any subscription, configure retry settings, and let the platform retry every 10 minutes until capacity is available — up to 3 days.

**Live Demo**: [https://proud-pebble-07440280f.5.azurestaticapps.net](https://proud-pebble-07440280f.5.azurestaticapps.net)

## How It Works

```
┌─────────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  Static Web App     │────▶│  Azure Functions API  │────▶│  State Store     │
│  (Dashboard + SSO)  │◀────│  (7 endpoints)        │◀────│  (Persistent)    │
└─────────────────────┘     └──────────────────────┘     └────────┬─────────┘
                                       │                          │
                              ┌────────▼─────────┐    ┌──────────▼────────┐
                              │  ARM REST API     │    │  Logic App        │
                              │  (Deploy + Poll)  │    │  (Every 10 min)   │
                              │  (Status Check)   │    │  → ProcessRetries │
                              └──────────────────┘    └───────────────────┘
```

## Quickstart — Deploy in 5 Minutes

### Prerequisites
- Azure CLI (`az`) logged in with Contributor role
- Node.js 18+
- GitHub account (for CI/CD)

### Step 1: Clone and Deploy Infrastructure

```bash
git clone https://github.com/ncheruvu-MSFT/azure-deployment-retry.git
cd azure-deployment-retry/infrastructure

# Deploy all Azure resources (SWA, Storage, Logic App, Managed Identity)
.\deploy.ps1 -ResourceGroupName "rg-deploy-retry" -Location "eastus2"
```

### Step 2: Deploy the App

**Option A — GitHub Actions (recommended)**:
```bash
# Fork the repo, then set this secret in your fork:
# Settings → Secrets → Actions → New:
#   SWA_DEPLOYMENT_TOKEN = <from Azure Portal → SWA → Manage deployment token>

# Every push to main auto-deploys via .github/workflows/deploy.yml
```

**Option B — CLI**:
```bash
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..

swa deploy --output-location frontend --api-location api \
  --deployment-token <YOUR_TOKEN> --env production \
  --api-language node --api-version 18
```

### Step 3: Configure App Settings

In the Azure Portal → Static Web App → Configuration → Application Settings:

| Setting | Value | Purpose |
|---------|-------|---------|
| `AZURE_TENANT_ID` | Your Entra ID tenant | ARM API authentication |
| `AZURE_CLIENT_ID` | Service principal app ID | ARM API authentication |
| `AZURE_CLIENT_SECRET` | SP secret (or use federated identity) | ARM API authentication |

The SP needs **Contributor** role on the subscription for ARM deployments.

### Step 4: Wire the Logic App

Update the Logic App to call the ProcessRetries API:
```bash
# The Logic App triggers every 10 min and calls:
# POST https://<your-swa>.azurestaticapps.net/api/process-retries
```

## How to Retry a Failed Deployment

### Method 1: Import from Azure (Recommended)

1. Open the app → **Import Failed** tab
2. Enter your **Subscription ID** → click **Load Resource Groups**
3. Select a Resource Group → click **Load Failed Deployments**
4. Configure: **Max Retries** (Forever, 6, 12, 36, 144, 432, 1008, Custom) and **Retry Frequency** (5/10/15/20/30/60 min)
5. Click **Retry** on any failed deployment
6. Switch to **Dashboard** → watch status update from Pending → Retrying → Succeeded/Failed

### Method 2: Submit New Request

1. Open the app → **New Request** tab
2. Fill in: Deployment Name, Resource Group, Subscription, Region, GPU SKU
3. Paste your ARM/Bicep/Terraform template
4. Configure retry settings (max retries + frequency)
5. Click **Submit** → the platform retries until capacity is available

### Method 3: API (Programmatic)

```bash
# Import a failed deployment for retry
curl -X POST https://<your-swa>/api/retry-deployment \
  -H "Content-Type: application/json" \
  -d '{"subscriptionId":"<sub>","resourceGroup":"<rg>","deploymentName":"<name>","maxAttempts":432,"retryIntervalMinutes":10}'

# Trigger retry processing manually
curl -X POST https://<your-swa>/api/process-retries

# Check status
curl https://<your-swa>/api/requests
```

## Capacity Errors Detected (Auto-Retry)

| Error Code | Description |
|------------|-------------|
| `AllocationFailed` | Region has no capacity for the requested VM size |
| `SkuNotAvailable` | Requested SKU not available in the region |
| `InsufficientCapacity` | Not enough capacity in the region |
| `InsufficientQuota` | Subscription quota exceeded for the resource |
| `QuotaExceeded` | Resource quota limit reached |
| `OverconstrainedAllocationRequest` | Constraints too strict for available capacity |

**Non-capacity errors** (InvalidTemplate, AuthorizationFailed, etc.) → fail immediately, no retry.

## GPU-Only Enforcement

This platform is designed for **GPU VM deployments** (NC, ND, NV, NP families). Before each retry attempt, a pre-flight check runs:

```
Pre-flight Check Flow:
  1. Is it a GPU SKU? (Standard_NC*, Standard_ND*, Standard_NV*, Standard_NP*)
     └─ NO → BLOCK retry ("Only GPU VMs supported")
  2. Is the GPU SKU available in the target region?
     └─ Restricted → SKIP retry ("Request access at aka.ms/ProdportalCR")
  3. Does the subscription have GPU vCPU quota?
     └─ Quota full → SKIP retry ("Request quota increase")
  4. All checks pass → PROCEED with ARM deployment
```

### Supported GPU Families

| Family | SKUs | GPU | Use Case |
|--------|------|-----|----------|
| **NC** | NC6s_v3, NC12s_v3, NC24s_v3, NC24ads_A100_v4, etc. | V100, A100 | Training, inference |
| **ND** | ND96asr_v4, ND96amsr_A100_v4, ND40rs_v2, etc. | A100, V100 | Large-scale training |
| **NV** | NV12s_v3, NV24s_v3, etc. | T4, A10 | Visualization, inference |
| **NP** | NP10s, NP20s, NP40s | Xilinx U250 | FPGA acceleration |

### Quota Check API

```bash
# Check GPU SKU availability + quota before submitting
GET /api/check-quota?subscriptionId=<sub>&region=<region>&vmSku=<sku>

# Example response:
{
  "canRetry": true,
  "summary": "Pre-flight passed: Standard_NC24ads_A100_v4 ready in eastus2",
  "checks": [
    { "check": "SKU Availability", "available": true,
      "capabilities": { "vCPUs": "24", "gpus": "1", "memory": "220" } },
    { "check": "GPU Quota", "withinQuota": true,
      "checks": [
        { "name": "Standard NC Family vCPUs", "usage": 0, "limit": 24, "available": 24 }
      ]}
  ]
}
```

## Retry Configuration

| Setting | Options | Default |
|---------|---------|---------|
| **Max Retries** | Forever (∞), 6, 12, 36, 144, 432, 1008, Custom | 432 (3 days) |
| **Retry Frequency** | Immediately, 5, 10, 15, 20, 30, 60 min | 10 min |

### Overlap Protection
- Skips retry if previous attempt was less than `retryInterval` ago
- Checks if an ARM deployment is still Running/Accepted before submitting a new one
- Polls deployment status for 60 seconds after submission to detect async failures

## Authentication

| Component | Auth Method |
|-----------|------------|
| **UI (all pages)** | Entra ID SSO (SWA built-in) |
| **API endpoints** | Anonymous (for Logic App access) |
| **ARM operations** | Service Principal with Contributor |
| **Crawling** | Blocked (robots.txt + noindex headers) |

For SSO on SWA Standard tier, see `CUSTOMER_DEPLOYMENT_GUIDE.md`.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/requests` | List all retry requests (optional `?status=` filter) |
| `GET` | `/api/requests/{id}` | Get full request detail with attempt history |
| `POST` | `/api/requests` | Submit a new deployment retry request |
| `PUT` | `/api/requests/{id}/cancel` | Cancel a pending/retrying request |
| `GET` | `/api/failed-deployments` | Browse failed deployments from ARM (`?subscriptionId=&resourceGroup=`) |
| `POST` | `/api/retry-deployment` | Import a failed deployment for retry |
| `POST` | `/api/process-retries` | Process all pending retries (called by Logic App) |

## Cost Estimate

| Resource | SKU | Monthly Cost |
|----------|-----|-------------|
| Static Web App | Free | **$0** |
| Logic App (Consumption) | Per-execution | **~$3–5** |
| Storage/Cosmos (Serverless) | Pay-per-use | **~$1–5** |
| **Total** | | **~$4–10/month** |

## File Structure

```
azure-deployment-retry/
├── .github/workflows/deploy.yml    # CI/CD pipeline
├── frontend/
│   ├── index.html                  # SPA (Dashboard, Import Failed, New Request)
│   ├── css/styles.css              # Purple gradient theme
│   ├── js/app.js                   # Client logic
│   ├── staticwebapp.config.json    # Auth + routing
│   └── robots.txt                  # noindex/nofollow
├── api/
│   ├── shared/
│   │   ├── blobClient.js           # State store (GitHub/Cosmos/Blob)
│   │   ├── azureAuth.js            # AAD token (federated + secret)
│   │   └── armClient.js            # ARM REST client
│   ├── GetRequests/                # GET  /api/requests
│   ├── GetRequest/                 # GET  /api/requests/{id}
│   ├── SubmitRequest/              # POST /api/requests
│   ├── CancelRequest/              # PUT  /api/requests/{id}/cancel
│   ├── FailedDeployments/          # GET  /api/failed-deployments
│   ├── RetryDeployment/            # POST /api/retry-deployment
│   └── ProcessRetries/             # POST /api/process-retries
├── infrastructure/
│   ├── main.bicep                  # All Azure resources (CAF naming)
│   ├── main.bicepparam             # Default parameters
│   └── deploy.ps1                  # Deployment script
├── state/requests.json             # Persistent state file
├── CUSTOMER_DEPLOYMENT_GUIDE.md    # Full deployment + auth + cost guide
├── LICENSE                         # MIT
└── README.md
```
