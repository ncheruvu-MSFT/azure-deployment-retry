#Requires -Modules Az.Accounts, Az.Resources

<#
.SYNOPSIS
    Deploys the Azure Deployment Retry Platform infrastructure.

.DESCRIPTION
    Creates the resource group (if needed), deploys the Bicep template, and
    assigns the Logic App managed identity Contributor at subscription scope
    so it can submit ARM deployments to any resource group.

.PARAMETER ResourceGroupName
    Name of the target resource group.

.PARAMETER Location
    Azure region (must match the Bicep parameter). Defaults to eastus2.

.PARAMETER ProjectName
    Project prefix for resource naming. Defaults to 'deploy-retry'.

.PARAMETER RetryIntervalMinutes
    Minutes between retry cycles. Defaults to 10.

.PARAMETER MaxRetryAttempts
    Max attempts before a request is marked failed. Defaults to 144.

.EXAMPLE
    .\deploy.ps1 -ResourceGroupName rg-deploy-retry -Location eastus2
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [string]$Location = 'eastus2',

    [string]$ProjectName = 'deploy-retry',

    [int]$RetryIntervalMinutes = 10,

    [int]$MaxRetryAttempts = 144,

    [string]$NotificationEmail = '',

    [string]$TeamsWebhookUrl = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Ensure logged in ─────────────────────────────────────────────────────────
$context = Get-AzContext
if (-not $context) {
    Write-Error 'Not logged in. Run Connect-AzAccount first.'
    return
}
$subscriptionId = $context.Subscription.Id
Write-Host "Subscription : $subscriptionId" -ForegroundColor Cyan
Write-Host "Region       : $Location" -ForegroundColor Cyan

# ── Create resource group if it doesn't exist ────────────────────────────────
$rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
if (-not $rg) {
    Write-Host "Creating resource group '$ResourceGroupName' in '$Location'..." -ForegroundColor Yellow
    $rg = New-AzResourceGroup -Name $ResourceGroupName -Location $Location
}
Write-Host "Resource group: $($rg.ResourceGroupName)" -ForegroundColor Green

# ── Deploy Bicep template ────────────────────────────────────────────────────
$templateFile = Join-Path $PSScriptRoot 'main.bicep'

Write-Host "`nDeploying infrastructure..." -ForegroundColor Yellow

$deployParams = @{
    ResourceGroupName = $ResourceGroupName
    TemplateFile      = $templateFile
    location          = $Location
    projectName       = $ProjectName
    retryIntervalMinutes = $RetryIntervalMinutes
    maxRetryAttempts  = $MaxRetryAttempts
    notificationEmail = $NotificationEmail
    teamsWebhookUrl   = $TeamsWebhookUrl
}

$deployment = New-AzResourceGroupDeployment @deployParams -Name "deploy-retry-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

if ($deployment.ProvisioningState -ne 'Succeeded') {
    Write-Error "Deployment failed with state: $($deployment.ProvisioningState)"
    return
}

# ── Extract outputs ──────────────────────────────────────────────────────────
$swaUrl             = $deployment.Outputs['staticWebAppUrl'].Value
$swaName            = $deployment.Outputs['staticWebAppName'].Value
$storageAccountName = $deployment.Outputs['storageAccountName'].Value
$logicAppName       = $deployment.Outputs['logicAppName'].Value
$principalId        = $deployment.Outputs['logicAppPrincipalId'].Value

# ── Subscription-level Contributor for the Logic App MI ──────────────────────
# The Bicep template assigns Contributor at resource-group scope. For
# cross-RG deployments the identity also needs subscription-level Contributor.
$contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
$scope = "/subscriptions/$subscriptionId"

$existing = Get-AzRoleAssignment -ObjectId $principalId `
    -RoleDefinitionId $contributorRoleId `
    -Scope $scope `
    -ErrorAction SilentlyContinue

if (-not $existing) {
    Write-Host "`nAssigning Contributor role at subscription scope..." -ForegroundColor Yellow
    New-AzRoleAssignment -ObjectId $principalId `
        -RoleDefinitionId $contributorRoleId `
        -Scope $scope `
        -ErrorAction Stop | Out-Null
    Write-Host "Role assigned." -ForegroundColor Green
} else {
    Write-Host "`nSubscription-level Contributor role already assigned." -ForegroundColor Green
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host   "║  Deployment Retry Platform — Deployed Successfully          ║" -ForegroundColor Cyan
Write-Host   "╠══════════════════════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host   "║  Static Web App URL : $swaUrl" -ForegroundColor Cyan
Write-Host   "║  Storage Account    : $storageAccountName" -ForegroundColor Cyan
Write-Host   "║  Logic App          : $logicAppName" -ForegroundColor Cyan
Write-Host   "║  Blob Container     : deployment-requests" -ForegroundColor Cyan
Write-Host   "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

# Return structured output for automation
[PSCustomObject]@{
    StaticWebAppUrl    = $swaUrl
    StaticWebAppName   = $swaName
    StorageAccountName = $storageAccountName
    LogicAppName       = $logicAppName
    PrincipalId        = $principalId
}
