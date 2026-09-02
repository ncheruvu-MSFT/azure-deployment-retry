using './main.bicep'

param location = 'eastus2'
param projectName = 'deploy-retry'
param retryIntervalMinutes = 10
param maxRetryAttempts = 432
param notificationEmail = ''
param teamsWebhookUrl = ''
