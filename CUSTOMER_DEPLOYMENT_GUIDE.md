# Customer Deployment Guide

## Overview

The Azure Deployment Retry Platform is a self-service portal for teams deploying GPU/AI workloads in capacity-constrained Azure regions. It automates retry logic for failed deployments — when Azure doesn't have capacity for your requested VM SKU or AI model, the platform retries every 10 minutes until it succeeds.

## Prerequisites

- Azure subscription with Contributor access
- Entra ID (Azure AD) tenant for SSO authentication
- Azure CLI installed locally
- Node.js 18+ (for local development only)

## Step 1: Register an Entra ID App with Federated Identity (Recommended)

Federated identity eliminates client secrets — the app authenticates using GitHub's OIDC token or Azure's managed identity.

### Option A: Federated Identity for GitHub Actions (CI/CD)

```bash
# Create app registration
APP_ID=$(az ad app create \
  --display-name "Deployment Retry Platform" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)

# Create service principal
SP_OID=$(az ad sp create --id $APP_ID --query id -o tsv)

# Add federated credential for GitHub Actions
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-deploy",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<GITHUB_ORG>/<REPO_NAME>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# Assign Contributor on the subscription
az role assignment create --assignee-object-id $SP_OID \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope /subscriptions/<SUBSCRIPTION_ID>

echo "Set these GitHub secrets:"
echo "  AZURE_CLIENT_ID=$APP_ID"
echo "  AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)"
echo "  AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)"
```

### Option B: Federated Identity for SWA API (Runtime)

For the SWA Functions API to call ARM without secrets, use a **User-Assigned Managed Identity**:

```bash
# Create managed identity
MI_ID=$(az identity create \
  --name "deploy-retry-api-identity" \
  --resource-group "rg-deploy-retry" \
  --query clientId -o tsv)

MI_PRINCIPAL=$(az identity show \
  --name "deploy-retry-api-identity" \
  --resource-group "rg-deploy-retry" \
  --query principalId -o tsv)

# Assign Contributor for ARM deployments
az role assignment create --assignee-object-id $MI_PRINCIPAL \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope /subscriptions/<SUBSCRIPTION_ID>

# Assign Cosmos DB Data Contributor
az cosmosdb sql role assignment create \
  --account-name <COSMOS_NAME> \
  --resource-group "rg-deploy-retry" \
  --role-definition-id "00000000-0000-0000-0000-000000000002" \
  --principal-id $MI_PRINCIPAL --scope "/"
```

> **Note**: SWA Standard tier supports linked backends with managed identity. For SWA Free tier, use `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` app settings as a fallback.

### Option C: Client Secret (Simplest, not recommended for production)

```bash
# Create app + secret
az ad app create --display-name "Deployment Retry Platform" --query appId -o tsv
az ad app credential reset --id <APP_ID> --display-name "SWA Auth"
```

Set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` as SWA app settings.

## Step 1b: Register SSO App for User Login

```bash
# Create app registration
az ad app create \
  --display-name "Deployment Retry Platform" \
  --web-redirect-uris "https://<YOUR-SWA-HOSTNAME>/.auth/login/aad/callback" \
  --sign-in-audience AzureADMyOrg \
  --query "{appId:appId, id:id}" -o table

# Create a client secret
az ad app credential reset --id <APP_ID> --display-name "SWA Auth" --query "{password:password}" -o table
```

Save the **Application (client) ID** and **Client Secret**.

## Step 2: Deploy Infrastructure

```powershell
cd infrastructure

.\deploy.ps1 -ResourceGroupName "rg-deploy-retry" `
  -Location "eastus2" `
  -RetryIntervalMinutes 10 `
  -MaxRetryAttempts 144 `
  -NotificationEmail "platform-team@contoso.com" `
  -TeamsWebhookUrl "https://outlook.office.com/webhook/..."
```

## Step 3: Configure SSO on the Static Web App

```bash
# Set the AAD app credentials as SWA app settings
az staticwebapp appsettings set \
  --name "<SWA_NAME>" \
  --setting-names \
    "AAD_CLIENT_ID=<APP_ID>" \
    "AAD_CLIENT_SECRET=<CLIENT_SECRET>"
```

Update `staticwebapp.config.json` → `auth.identityProviders.azureActiveDirectory.registration.openIdIssuer` with your tenant ID:
```
https://login.microsoftonline.com/<YOUR_TENANT_ID>/v2.0
```

## Step 4: Deploy the Application

```bash
npm install -g @azure/static-web-apps-cli

swa deploy \
  --output-location frontend \
  --api-location api \
  --deployment-token <TOKEN> \
  --env production \
  --api-language node \
  --api-version 18
```

## Step 5: Verify

1. Navigate to `https://<SWA_HOSTNAME>` — you should be redirected to Entra ID login
2. After login, the dashboard loads with your user identity in the header
3. Try the **Import Failed** tab to browse failed deployments in your subscription

---

## Authentication & Security

| Layer | Protection |
|---|---|
| **UI Access** | Entra ID SSO — only `authenticated` users can access any route |
| **API Access** | All `/api/*` routes require `authenticated` role |
| **Social providers** | GitHub and Twitter login routes return 404 (disabled) |
| **ARM Operations** | Service Principal with Contributor role — scoped to subscription |
| **Data Store** | Cosmos DB with Entra ID RBAC (no key auth) |
| **Network** | Storage/Cosmos private endpoints recommended for production |

### Role-Based Access (Optional Enhancement)

To restrict who can submit retry requests vs. just view them:
```json
{
  "routes": [
    { "route": "/api/requests", "methods": ["GET"], "allowedRoles": ["authenticated"] },
    { "route": "/api/requests", "methods": ["POST"], "allowedRoles": ["admin"] },
    { "route": "/api/retry-deployment", "allowedRoles": ["admin"] }
  ]
}
```

Then assign roles via SWA invitation:
```bash
az staticwebapp users invite \
  --name <SWA_NAME> \
  --authentication-provider aad \
  --user-details "user@contoso.com" \
  --role admin
```

---

## Retry Configuration

| Parameter | Default | Description |
|---|---|---|
| `retryIntervalMinutes` | 10 | Minutes between each retry attempt |
| `maxRetryAttempts` | 144 | Max attempts before marking failed (144 × 10min = 24h) |

### Capacity Errors Detected (auto-retry)
- `AllocationFailed`
- `SkuNotAvailable`
- `InsufficientCapacity`
- `QuotaExceeded`
- `OverconstrainedAllocationRequest`

### Non-capacity Errors (fail immediately)
- `InvalidTemplate`
- `AuthorizationFailed`
- `ResourceGroupNotFound`
- Any error NOT matching the capacity patterns above

---

## Monthly Cost Estimate

### Minimal / Dev (Free Tier where possible)

| Resource | SKU | Monthly Cost |
|---|---|---|
| Static Web App | Free | **$0** |
| Cosmos DB (Serverless) | Serverless | **~$1–5** (pay per RU, minimal for this workload) |
| Logic App (Consumption) | Per-execution | **~$1–3** (144 runs/day × 30 days = 4,320 executions) |
| Storage Account | Standard LRS | **~$0.50** (blob storage for templates) |
| **Total** | | **~$2–9/month** |

### Production (Standard Tier)

| Resource | SKU | Monthly Cost |
|---|---|---|
| Static Web App | Standard | **$9/month** (custom domains, SLA, staging) |
| Cosmos DB (Serverless) | Serverless | **~$5–15** (depends on request volume) |
| Logic App (Consumption) | Per-execution | **~$5–10** (higher volume, notifications) |
| Storage Account | Standard LRS | **~$1** |
| Key Vault (optional) | Standard | **~$0.03/secret/month** |
| **Total** | | **~$20–35/month** |

### Cost Breakdown — Logic App Executions

```
Retry interval: 10 minutes
Max retries per request: 144
Recurrence trigger: 1 run every 10 min = 6/hour = 144/day = 4,320/month

Per run actions (typical):
  - 1 trigger (free first 4,000/month)
  - 1 list blobs
  - N × (read blob + parse + HTTP call + write blob)
  - N × conditional notification actions

Logic Apps pricing:
  - Triggers: $0.000025 each (first 4,000 free)
  - Actions: $0.000025 each
  - Standard connectors: $0.000125 per action (Blob, O365)

At 4,320 triggers/month + ~10 actions/run:
  = 4,320 triggers × $0.000025 = $0.11
  + 43,200 actions × $0.000025 = $1.08
  + connector actions ~$2.00
  ≈ $3.19/month
```

### Cosmos DB Serverless Estimate

```
Reads: ~4,320/month (Logic App scans) + ~1,000 UI reads = 5,320
Writes: ~500/month (status updates + new requests)
Storage: < 1 GB

RU cost: 5,820 operations × ~5 RUs each = 29,100 RUs
= 29,100 × $0.25 per million RUs = $0.007
+ Storage: 1 GB × $0.25 = $0.25
≈ $0.26/month
```

---

## Packaging for Customer Delivery

The entire platform is self-contained in the `azure-deployment-retry/` folder:

```
azure-deployment-retry/
├── infrastructure/          # Bicep IaC — one-command deploy
│   ├── main.bicep           # All Azure resources
│   ├── main.bicepparam      # Parameter defaults
│   └── deploy.ps1           # Deployment script
├── frontend/                # Static Web App UI
│   ├── index.html           # SPA dashboard
│   ├── css/styles.css       # Theme
│   ├── js/app.js            # Client logic
│   └── staticwebapp.config.json  # Auth + routing
├── api/                     # Azure Functions API
│   ├── shared/              # Cosmos client, Azure auth, ARM client
│   ├── GetRequests/         # List requests
│   ├── GetRequest/          # Get request detail
│   ├── SubmitRequest/       # Submit new request
│   ├── CancelRequest/       # Cancel request
│   ├── FailedDeployments/   # Browse failed deployments from ARM
│   └── RetryDeployment/     # Import failed deployment for retry
└── README.md                # Main documentation
```

### To package as a Git repo for a customer:

```bash
cd azure-deployment-retry
git init
git add -A
git commit -m "Azure Deployment Retry Platform v1.0"
```

### Customer customization points:
1. **Theme** — Edit `css/styles.css` CSS variables (`:root` block)
2. **GPU SKUs** — Edit `index.html` dropdown options
3. **Retry timing** — Change Bicep `retryIntervalMinutes` and `maxRetryAttempts`
4. **Notifications** — Add Teams webhook URL or email in deploy.ps1
5. **Auth** — Update tenant ID in `staticwebapp.config.json`
