using './main.bicep'

param location = 'eastus2'
param projectName = 'deploy-retry'
param retryIntervalMinutes = 10
param maxRetryAttempts = 144
param notificationEmail = ''
param teamsWebhookUrl = ''
