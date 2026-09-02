using './main.bicep'

param location = 'eastus2'
param workloadName = 'deployretry'
param environment = 'prod'
param retryIntervalMinutes = 10
param maxRetryAttempts = 432
param notificationEmail = ''
param teamsWebhookUrl = ''
