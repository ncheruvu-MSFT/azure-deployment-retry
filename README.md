# Azure Deployment Retry Platform

Automated retry system for Azure deployments that fail due to **GPU/capacity constraints**. Submit deployment requests via a web UI, and a Logic App retries every 10–15 minutes until the region has capacity.

## Architecture

```
┌────────────────────┐       ┌──────────────────────┐       ┌──────────────────┐
│  Static Web App    │──────▶│  Azure Functions API  │──────▶│  Blob Storage    │
│  (Dashboard UI)    │◀──────│  (CRUD on requests)   │◀──────│  (Request JSONs) │
└────────────────────┘       └──────────────────────┘       └────────┬─────────┘
                                                                     │
                                                            ┌────────▼─────────┐
                                                            │  Logic App       │
                                                            │  (Recurrence     │
                                                            │   every 10 min)  │
                                                            │                  │
                                                            │  • Read pending  │
                                                            │  • PUT ARM API   │
                                                            │  • Detect error  │
                                                            │  • Update blob   │
                                                            └──────────────────┘
```

## Components

| Folder | What | Tech |
|--------|------|------|
| `frontend/` | SWA dashboard — submit requests, view status, cancel | Vanilla HTML/CSS/JS, Fluent theme |
| `api/` | Azure Functions — CRUD endpoints for deployment requests | Node.js v4, `@azure/storage-blob` |
| `infrastructure/` | Bicep IaC — SWA, Storage, Logic App, Managed Identity | Bicep, PowerShell |

## Request Lifecycle

1. **Submit** → User fills form (deployment name, subscription, RG, region, GPU SKU, template type + content)
2. **Pending** → API writes JSON blob to `deployment-requests` container
3. **Retrying** → Logic App fires every 10 min, routes by template type:
   - **ARM/Bicep** → ARM REST API `PUT` deployment
   - **Terraform** → Azure Container Instance with `terraform apply`
4. **Capacity error detection** → Matches: `AllocationFailed`, `SkuNotAvailable`, `InsufficientCapacity`, `QuotaExceeded`, `OverconstrainedAllocationRequest`
5. **Succeeded** → Blob updated → Teams/email notification → visible in dashboard
6. **Failed** → Non-capacity error OR max attempts (144 = 24h) exceeded → notification sent → stops retrying

## Notifications

Notifications are **optional** and configurable per-deployment or globally via Bicep parameters.

| Channel | How to Enable | What You Get |
|---------|---------------|--------------|
| **Teams** | Provide an [Incoming Webhook URL](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) | Adaptive Card posted on success or failure with deployment name, region, attempt count, error summary |
| **Email** | Provide an email address (uses Office 365 Outlook connector) | HTML email on success (Normal priority) or failure (High priority) with full details |

Configure globally in `deploy.ps1`:
```powershell
.\deploy.ps1 -ResourceGroupName "rg-deploy-retry" -Location "eastus2" `
  -NotificationEmail "platform-team@contoso.com" `
  -TeamsWebhookUrl "https://outlook.office.com/webhook/..."
```

Or per-request via the UI's **Notification Settings** section on the submit form.

## Terraform Support

Terraform templates are deployed via **Azure Container Instance** (ACI):

1. Logic App detects `templateType == 'terraform'` in the request blob
2. Creates an ACI (`hashicorp/terraform:latest`) in the target resource group
3. Writes template content to `main.tf`, parameters to `terraform.tfvars.json`
4. Runs `terraform init && terraform apply -auto-approve`
5. Polls ACI status every 30 seconds (up to 30 minutes)
6. On completion: checks container logs for capacity errors → retries or marks failed
7. Cleans up the ACI container group

> **Note**: For production, assign a **user-assigned managed identity** to the ACI with appropriate RBAC on target resources. The ACI uses `ARM_USE_MSI=true` for the AzureRM Terraform provider.

## Quickstart

### Prerequisites

- Azure CLI (`az`) logged in
- Contributor role on target subscription
- Node.js 18+ (for local API development)

### Deploy Infrastructure

```powershell
cd infrastructure

# Basic deploy (no notifications)
.\deploy.ps1 -ResourceGroupName "rg-deploy-retry" -Location "eastus2"

# With notifications
.\deploy.ps1 -ResourceGroupName "rg-deploy-retry" -Location "eastus2" `
  -NotificationEmail "team@contoso.com" `
  -TeamsWebhookUrl "https://outlook.office.com/webhook/..."
```

This deploys:
- **Static Web App** (Free tier)
- **Storage Account** with `deployment-requests` container
- **Logic App** (Consumption) with 10-minute recurrence + notification actions
- **Managed Identity** with Contributor on RG + Storage Blob Data Contributor
- **Office 365 API Connection** (if email notification enabled)
- **Teams Webhook integration** (if webhook URL provided)

### Deploy Frontend + API to SWA

```powershell
# Install SWA CLI
npm install -g @azure/static-web-apps-cli

# From project root
swa deploy --app-location frontend --api-location api \
  --deployment-token <YOUR_SWA_DEPLOYMENT_TOKEN>
```

Get the deployment token from the Azure Portal → Static Web App → Manage deployment token.

### Configure API Environment

In the Azure Portal, add these **Application Settings** to the Static Web App:

| Setting | Value |
|---------|-------|
| `STORAGE_CONNECTION_STRING` | Connection string from the deployed storage account |
| `STORAGE_CONTAINER_NAME` | `deployment-requests` |

### Local Development

```powershell
# Install API dependencies
cd api && npm install && cd ..

# Run locally with SWA CLI
swa start frontend --api-location api
```

Set `STORAGE_CONNECTION_STRING` in `api/local.settings.json` for local blob access.

## API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/requests?status=` | List all requests (optional status filter) |
| `GET` | `/api/requests/{id}` | Get full request detail |
| `POST` | `/api/requests` | Submit new deployment request |
| `PUT` | `/api/requests/{id}/cancel` | Cancel a pending/retrying request |

## GPU SKUs Supported (Initial)

| SKU | GPU | Use Case |
|-----|-----|----------|
| `Standard_NC*s_v3` | V100 | Training, inference |
| `Standard_NC*as_T4_v3` | T4 | Inference, graphics |
| `Standard_ND96asr_v4` | A100 (8x) | Large-scale training |
| `Standard_ND96amsr_A100_v4` | A100 (8x) | Large-scale training |
| `Standard_NC*ads_A100_v4` | A100 (1-4x) | Training, fine-tuning |

## Customization

- **Retry interval**: Change `retryIntervalMinutes` param in Bicep (default: 10, range: 5–30)
- **Max attempts**: Change `maxRetryAttempts` param (default: 144 = 24h at 10-min intervals)
- **Add resource types**: Extend the UI dropdowns and Logic App error patterns
- **Notifications**: Add an email/Teams connector action in the Logic App after success/final failure

## File Structure

```
azure-deployment-retry/
├── frontend/
│   ├── index.html                  # SPA dashboard
│   ├── css/styles.css              # Fluent-inspired theme
│   ├── js/app.js                   # Client-side logic
│   └── staticwebapp.config.json    # SWA routing
├── api/
│   ├── package.json
│   ├── host.json
│   ├── local.settings.json
│   ├── shared/blobClient.js        # Blob storage helpers
│   ├── SubmitRequest/              # POST /api/requests
│   ├── GetRequests/                # GET  /api/requests
│   ├── GetRequest/                 # GET  /api/requests/{id}
│   └── CancelRequest/             # PUT  /api/requests/{id}/cancel
└── infrastructure/
    ├── main.bicep                  # All Azure resources
    ├── main.bicepparam             # Default parameters
    └── deploy.ps1                  # Deployment script
```
