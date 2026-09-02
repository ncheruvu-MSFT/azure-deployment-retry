// ============================================================================
// Azure Deployment Retry Platform — Infrastructure
// Deploys: Static Web App, Storage Account, Logic App (Consumption),
//          Managed Identity, API Connection for Blob Storage
// ============================================================================

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Project name used as a prefix for resource names.')
param projectName string = 'deploy-retry'

@minValue(5)
@maxValue(30)
@description('Minutes between retry attempts.')
param retryIntervalMinutes int = 10

@description('Maximum number of retry attempts (432 ≈ 3 days at 10-min intervals).')
param maxRetryAttempts int = 432

@description('Email address to receive deployment notifications (leave empty to disable email).')
param notificationEmail string = ''

@description('Microsoft Teams Incoming Webhook URL for notifications (leave empty to disable Teams).')
param teamsWebhookUrl string = ''

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

var uniqueSuffix = uniqueString(resourceGroup().id, projectName)
var storageAccountName = toLower('${replace(projectName, '-', '')}${take(uniqueSuffix, 8)}')
var logicAppName = '${projectName}-logic-${take(uniqueSuffix, 6)}'
var swaName = '${projectName}-swa-${take(uniqueSuffix, 6)}'
var blobContainerName = 'deployment-requests'
var apiConnectionName = '${projectName}-blob-conn'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var enableEmail = !empty(notificationEmail)
var enableTeams = !empty(teamsWebhookUrl)
var o365ConnectionName = '${projectName}-o365-conn'

// ---------------------------------------------------------------------------
// Storage Account + Blob Container
// ---------------------------------------------------------------------------

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource blobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobServices
  name: blobContainerName
  properties: {
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// Static Web App (Free tier)
// ---------------------------------------------------------------------------

resource staticWebApp 'Microsoft.Web/staticSites@2023-01-01' = {
  name: swaName
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

// ---------------------------------------------------------------------------
// API Connection — Azure Blob Storage (used by Logic App)
// ---------------------------------------------------------------------------

resource blobApiConnection 'Microsoft.Web/connections@2016-06-01' = {
  name: apiConnectionName
  location: location
  properties: {
    displayName: 'Deployment Retry Blob Connection'
    api: {
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'azureblob')
    }
    parameterValueSet: {
      name: 'managedIdentityAuth'
      values: {}
    }
  }
}

resource o365ApiConnection 'Microsoft.Web/connections@2016-06-01' = if (enableEmail) {
  name: o365ConnectionName
  location: location
  properties: {
    displayName: 'Deployment Retry Email Notifications'
    api: {
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'office365')
    }
    parameterValueSet: {
      name: 'oauthDefault'
      values: {}
    }
  }
}

// ---------------------------------------------------------------------------
// Logic App (Consumption) — with system-assigned managed identity
// ---------------------------------------------------------------------------

resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: logicAppName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': {
          defaultValue: {}
          type: 'Object'
        }
        storageAccountName: {
          defaultValue: storageAccountName
          type: 'String'
        }
        containerName: {
          defaultValue: blobContainerName
          type: 'String'
        }
        maxRetryAttempts: {
          defaultValue: maxRetryAttempts
          type: 'Int'
        }
        teamsWebhookUrl: {
          defaultValue: teamsWebhookUrl
          type: 'String'
        }
        notificationEmail: {
          defaultValue: notificationEmail
          type: 'String'
        }
      }
      triggers: {
        Recurrence: {
          type: 'Recurrence'
          recurrence: {
            frequency: 'Minute'
            interval: retryIntervalMinutes
          }
        }
      }
      actions: {
        // ── STEP 1: List all blobs in the container ──────────────────────
        List_Blobs: {
          type: 'ApiConnection'
          inputs: {
            host: {
              connection: {
                name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
              }
            }
            method: 'get'
            path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/foldersV2/@{encodeURIComponent(encodeURIComponent(parameters(\'containerName\')))}'
            queries: {
              nextPageMarker: ''
              useFlatListing: true
            }
          }
          runAfter: {}
        }

        // ── STEP 2: Filter to only .json blobs ──────────────────────────
        Filter_JSON_Blobs: {
          type: 'Query'
          inputs: {
            from: '@body(\'List_Blobs\')?[\'value\']'
            where: '@endsWith(item()?[\'Name\'], \'.json\')'
          }
          runAfter: {
            List_Blobs: [ 'Succeeded' ]
          }
        }

        // ── STEP 3: Process each blob ───────────────────────────────────
        For_Each_Blob: {
          type: 'Foreach'
          foreach: '@body(\'Filter_JSON_Blobs\')'
          actions: {

            // ── 3a: Read blob content ─────────────────────────────────
            Read_Blob_Content: {
              type: 'ApiConnection'
              inputs: {
                host: {
                  connection: {
                    name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                  }
                }
                method: 'get'
                path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}/content'
              }
              runAfter: {}
            }

            // ── 3b: Parse the JSON request document ───────────────────
            Parse_Request_JSON: {
              type: 'ParseJson'
              inputs: {
                content: '@body(\'Read_Blob_Content\')'
                schema: {
                  type: 'object'
                  properties: {
                    deploymentName: { type: 'string' }
                    subscriptionId: { type: 'string' }
                    resourceGroupName: { type: 'string' }
                    template: { type: 'object' }
                    parameters: { type: 'object' }
                    status: { type: 'string' }
                    attemptCount: { type: 'integer' }
                    lastAttempt: { type: 'string' }
                    createdAt: { type: 'string' }
                    lastError: { type: 'string' }
                  }
                }
              }
              runAfter: {
                Read_Blob_Content: [ 'Succeeded' ]
              }
            }

            // ── 3c: Check if blob qualifies for processing ────────────
            Check_Status_And_Attempts: {
              type: 'If'
              expression: {
                and: [
                  {
                    or: [
                      {
                        equals: [ '@body(\'Parse_Request_JSON\')?[\'status\']', 'pending' ]
                      }
                      {
                        equals: [ '@body(\'Parse_Request_JSON\')?[\'status\']', 'retrying' ]
                      }
                    ]
                  }
                  {
                    lessOrEquals: [
                      '@coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0)'
                      '@parameters(\'maxRetryAttempts\')'
                    ]
                  }
                ]
              }
              actions: {
                // ── Route based on template type (ARM vs Terraform) ───
                Check_Template_Type: {
                  type: 'If'
                  expression: {
                    equals: [ '@body(\'Parse_Request_JSON\')?[\'templateType\']', 'terraform' ]
                  }
                  actions: {
                    // ── TERRAFORM PATH: deploy via Azure Container Instance ──
                    Try_Terraform_Deploy: {
                      type: 'Scope'
                      actions: {
                        Create_ACI_For_Terraform: {
                          type: 'Http'
                          inputs: {
                            method: 'PUT'
                            uri: 'https://management.azure.com/subscriptions/@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}/resourceGroups/@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}/providers/Microsoft.ContainerInstance/containerGroups/tf-@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}?api-version=2023-05-01'
                            body: {
                              location: '@{body(\'Parse_Request_JSON\')?[\'region\']}'
                              properties: {
                                containers: [
                                  {
                                    name: 'terraform'
                                    properties: {
                                      image: 'hashicorp/terraform:latest'
                                      command: [ '/bin/sh', '-c', 'echo "$TF_CONTENT" > main.tf && echo "$TF_VARS" > terraform.tfvars.json && terraform init -input=false && terraform apply -auto-approve -input=false' ]
                                      environmentVariables: [
                                        {
                                          name: 'TF_CONTENT'
                                          secureValue: '@{body(\'Parse_Request_JSON\')?[\'template\']}'
                                        }
                                        {
                                          name: 'TF_VARS'
                                          secureValue: '@{string(body(\'Parse_Request_JSON\')?[\'parameters\'])}'
                                        }
                                        {
                                          name: 'ARM_USE_MSI'
                                          value: 'true'
                                        }
                                        {
                                          name: 'ARM_SUBSCRIPTION_ID'
                                          value: '@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}'
                                        }
                                      ]
                                      resources: {
                                        requests: {
                                          cpu: 1
                                          memoryInGB: '1.5'
                                        }
                                      }
                                    }
                                  }
                                ]
                                osType: 'Linux'
                                restartPolicy: 'Never'
                              }
                            }
                            authentication: {
                              type: 'ManagedServiceIdentity'
                              audience: 'https://management.azure.com/'
                            }
                          }
                          runAfter: {}
                        }

                        Wait_For_ACI: {
                          type: 'Until'
                          expression: '@or(equals(body(\'Check_ACI_Status\')?[\'properties\']?[\'instanceView\']?[\'state\'], \'Succeeded\'), equals(body(\'Check_ACI_Status\')?[\'properties\']?[\'instanceView\']?[\'state\'], \'Failed\'), equals(body(\'Check_ACI_Status\')?[\'properties\']?[\'instanceView\']?[\'state\'], \'Stopped\'))'
                          limit: {
                            count: 60
                            timeout: 'PT30M'
                          }
                          actions: {
                            Wait_30_Seconds: {
                              type: 'Wait'
                              inputs: {
                                interval: {
                                  count: 30
                                  unit: 'Second'
                                }
                              }
                              runAfter: {}
                            }
                            Check_ACI_Status: {
                              type: 'Http'
                              inputs: {
                                method: 'GET'
                                uri: 'https://management.azure.com/subscriptions/@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}/resourceGroups/@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}/providers/Microsoft.ContainerInstance/containerGroups/tf-@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}?api-version=2023-05-01'
                                authentication: {
                                  type: 'ManagedServiceIdentity'
                                  audience: 'https://management.azure.com/'
                                }
                              }
                              runAfter: {
                                Wait_30_Seconds: [ 'Succeeded' ]
                              }
                            }
                          }
                          runAfter: {
                            Create_ACI_For_Terraform: [ 'Succeeded' ]
                          }
                        }

                        Check_TF_Result: {
                          type: 'If'
                          expression: {
                            equals: [ '@body(\'Check_ACI_Status\')?[\'properties\']?[\'instanceView\']?[\'state\']', 'Succeeded' ]
                          }
                          actions: {
                            Update_Blob_TF_Succeeded: {
                              type: 'ApiConnection'
                              inputs: {
                                host: {
                                  connection: {
                                    name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                                  }
                                }
                                method: 'put'
                                path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"templateType":"terraform",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"succeeded",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":null\', \'}\'))'
                              }
                              runAfter: {}
                            }

                            // Terraform success notifications
                            Check_Teams_Enabled_TF_Success: {
                              type: 'If'
                              expression: { not: { equals: [ '@parameters(\'teamsWebhookUrl\')', '' ] } }
                              actions: {
                                Send_Teams_TF_Success: {
                                  type: 'Http'
                                  inputs: {
                                    method: 'POST'
                                    uri: '@parameters(\'teamsWebhookUrl\')'
                                    headers: { 'Content-Type': 'application/json' }
                                    body: {
                                      type: 'message'
                                      attachments: [
                                        {
                                          contentType: 'application/vnd.microsoft.card.adaptive'
                                          contentUrl: null
                                          content: {
                                            '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                                            type: 'AdaptiveCard'
                                            version: '1.4'
                                            body: [
                                              {
                                                type: 'TextBlock'
                                                text: '✅ Terraform Deployment Succeeded'
                                                weight: 'Bolder'
                                                size: 'Large'
                                                color: 'Good'
                                              }
                                              {
                                                type: 'FactSet'
                                                facts: [
                                                  { title: 'Deployment', value: '@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}' }
                                                  { title: 'Resource Group', value: '@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}' }
                                                  { title: 'Attempts', value: '@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}' }
                                                  { title: 'Completed', value: '@{utcNow()}' }
                                                ]
                                              }
                                            ]
                                          }
                                        }
                                      ]
                                    }
                                  }
                                  runAfter: {}
                                }
                              }
                              else: { actions: {} }
                              runAfter: {
                                Update_Blob_TF_Succeeded: [ 'Succeeded' ]
                              }
                            }

                            Check_Email_Enabled_TF_Success: {
                              type: 'If'
                              expression: { not: { equals: [ '@parameters(\'notificationEmail\')', '' ] } }
                              actions: {
                                Send_Email_TF_Success: {
                                  type: 'ApiConnection'
                                  inputs: {
                                    host: {
                                      connection: {
                                        name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
                                      }
                                    }
                                    method: 'post'
                                    path: '/v2/Mail'
                                    body: {
                                      To: '@parameters(\'notificationEmail\')'
                                      Subject: '✅ Terraform Deployment Succeeded: @{body(\'Parse_Request_JSON\')?[\'deploymentName\']}'
                                      Body: '<h2>Terraform Deployment Succeeded</h2><table><tr><td><b>Deployment</b></td><td>@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}</td></tr><tr><td><b>Resource Group</b></td><td>@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}</td></tr><tr><td><b>Subscription</b></td><td>@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}</td></tr><tr><td><b>Attempts</b></td><td>@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}</td></tr><tr><td><b>Completed</b></td><td>@{utcNow()}</td></tr></table>'
                                      IsHtml: true
                                      Importance: 'Normal'
                                    }
                                  }
                                  runAfter: {}
                                }
                              }
                              else: { actions: {} }
                              runAfter: {
                                Update_Blob_TF_Succeeded: [ 'Succeeded' ]
                              }
                            }
                          }
                          else: {
                            actions: {
                              Get_TF_Logs: {
                                type: 'Http'
                                inputs: {
                                  method: 'GET'
                                  uri: 'https://management.azure.com/subscriptions/@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}/resourceGroups/@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}/providers/Microsoft.ContainerInstance/containerGroups/tf-@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}/containers/terraform/logs?api-version=2023-05-01'
                                  authentication: {
                                    type: 'ManagedServiceIdentity'
                                    audience: 'https://management.azure.com/'
                                  }
                                }
                                runAfter: {}
                              }

                              Check_TF_Capacity_Error: {
                                type: 'If'
                                expression: {
                                  or: [
                                    { contains: [ '@toLower(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'\'))', 'allocationfailed' ] }
                                    { contains: [ '@toLower(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'\'))', 'skunotavailable' ] }
                                    { contains: [ '@toLower(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'\'))', 'insufficientcapacity' ] }
                                    { contains: [ '@toLower(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'\'))', 'quotaexceeded' ] }
                                    { contains: [ '@toLower(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'\'))', 'overconstrainedallocationrequest' ] }
                                  ]
                                }
                                actions: {
                                  Update_Blob_TF_Retrying: {
                                    type: 'ApiConnection'
                                    inputs: {
                                      host: { connection: { name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']' } }
                                      method: 'put'
                                      path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                      body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"templateType":"terraform",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"retrying",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":"Capacity error in Terraform apply"\', \'}\'))'
                                    }
                                    runAfter: {}
                                  }
                                }
                                else: {
                                  actions: {
                                    Update_Blob_TF_Failed: {
                                      type: 'ApiConnection'
                                      inputs: {
                                        host: { connection: { name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']' } }
                                        method: 'put'
                                        path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                        body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"templateType":"terraform",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"failed",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":"\', replace(take(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'Unknown error\'), 300), \'"\', \'\\\\"\'  ), \'"\', \'}\'))'
                                      }
                                      runAfter: {}
                                    }

                                    // TF failure notifications
                                    Check_Teams_Enabled_TF_Fail: {
                                      type: 'If'
                                      expression: { not: { equals: [ '@parameters(\'teamsWebhookUrl\')', '' ] } }
                                      actions: {
                                        Send_Teams_TF_Failure: {
                                          type: 'Http'
                                          inputs: {
                                            method: 'POST'
                                            uri: '@parameters(\'teamsWebhookUrl\')'
                                            headers: { 'Content-Type': 'application/json' }
                                            body: {
                                              type: 'message'
                                              attachments: [
                                                {
                                                  contentType: 'application/vnd.microsoft.card.adaptive'
                                                  contentUrl: null
                                                  content: {
                                                    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                                                    type: 'AdaptiveCard'
                                                    version: '1.4'
                                                    body: [
                                                      {
                                                        type: 'TextBlock'
                                                        text: '❌ Terraform Deployment Failed'
                                                        weight: 'Bolder'
                                                        size: 'Large'
                                                        color: 'Attention'
                                                      }
                                                      {
                                                        type: 'FactSet'
                                                        facts: [
                                                          { title: 'Deployment', value: '@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}' }
                                                          { title: 'Resource Group', value: '@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}' }
                                                          { title: 'Attempts', value: '@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}' }
                                                          { title: 'Error', value: '@{take(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'Unknown error\'), 200)}' }
                                                        ]
                                                      }
                                                    ]
                                                  }
                                                }
                                              ]
                                            }
                                          }
                                          runAfter: {}
                                        }
                                      }
                                      else: { actions: {} }
                                      runAfter: {
                                        Update_Blob_TF_Failed: [ 'Succeeded' ]
                                      }
                                    }

                                    Check_Email_Enabled_TF_Fail: {
                                      type: 'If'
                                      expression: { not: { equals: [ '@parameters(\'notificationEmail\')', '' ] } }
                                      actions: {
                                        Send_Email_TF_Failure: {
                                          type: 'ApiConnection'
                                          inputs: {
                                            host: {
                                              connection: {
                                                name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
                                              }
                                            }
                                            method: 'post'
                                            path: '/v2/Mail'
                                            body: {
                                              To: '@parameters(\'notificationEmail\')'
                                              Subject: '❌ Terraform Deployment Failed: @{body(\'Parse_Request_JSON\')?[\'deploymentName\']}'
                                              Body: '<h2>Terraform Deployment Failed</h2><table><tr><td><b>Deployment</b></td><td>@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}</td></tr><tr><td><b>Resource Group</b></td><td>@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}</td></tr><tr><td><b>Subscription</b></td><td>@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}</td></tr><tr><td><b>Attempts</b></td><td>@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}</td></tr><tr><td><b>Error</b></td><td>@{take(coalesce(body(\'Get_TF_Logs\')?[\'content\'], \'Unknown error\'), 500)}</td></tr></table>'
                                              IsHtml: true
                                              Importance: 'High'
                                            }
                                          }
                                          runAfter: {}
                                        }
                                      }
                                      else: { actions: {} }
                                      runAfter: {
                                        Update_Blob_TF_Failed: [ 'Succeeded' ]
                                      }
                                    }
                                  }
                                }
                                runAfter: { Get_TF_Logs: [ 'Succeeded', 'Failed' ] }
                              }

                              Delete_TF_ACI: {
                                type: 'Http'
                                inputs: {
                                  method: 'DELETE'
                                  uri: 'https://management.azure.com/subscriptions/@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}/resourceGroups/@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}/providers/Microsoft.ContainerInstance/containerGroups/tf-@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}?api-version=2023-05-01'
                                  authentication: {
                                    type: 'ManagedServiceIdentity'
                                    audience: 'https://management.azure.com/'
                                  }
                                }
                                runAfter: { Check_TF_Capacity_Error: [ 'Succeeded', 'Failed' ] }
                              }
                            }
                          }
                          runAfter: { Wait_For_ACI: [ 'Succeeded' ] }
                        }
                      }
                      runAfter: {}
                    }
                  }
                  else: {
                    actions: {
                      // ── ARM/BICEP PATH: existing deployment logic ──────
                      Try_Deploy: {
                        type: 'Scope'
                        actions: {
                          Call_ARM_Deployment: {
                            type: 'Http'
                            inputs: {
                              method: 'PUT'
                              uri: 'https://management.azure.com/subscriptions/@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}/resourceGroups/@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}/providers/Microsoft.Resources/deployments/@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}?api-version=2021-04-01'
                              body: {
                                properties: {
                                  mode: 'Incremental'
                                  template: '@body(\'Parse_Request_JSON\')?[\'template\']'
                                  parameters: '@body(\'Parse_Request_JSON\')?[\'parameters\']'
                                }
                              }
                              authentication: {
                                type: 'ManagedServiceIdentity'
                                audience: 'https://management.azure.com/'
                              }
                            }
                            runAfter: {}
                          }

                          Log_Deployment_Attempt: {
                            type: 'Compose'
                            inputs: {
                              message: 'ARM deployment submitted'
                              deploymentName: '@body(\'Parse_Request_JSON\')?[\'deploymentName\']'
                              attempt: '@add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)'
                              timestamp: '@utcNow()'
                              statusCode: '@outputs(\'Call_ARM_Deployment\')?[\'statusCode\']'
                            }
                            runAfter: {
                              Call_ARM_Deployment: [ 'Succeeded' ]
                            }
                          }

                          Update_Blob_Succeeded: {
                            type: 'ApiConnection'
                            inputs: {
                              host: {
                                connection: {
                                  name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                                }
                              }
                              method: 'put'
                              path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                              body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"succeeded",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":null\', \'}\'))'
                            }
                            runAfter: {
                              Log_Deployment_Attempt: [ 'Succeeded' ]
                            }
                          }

                          // Success notifications
                          Check_Teams_Enabled_Success: {
                            type: 'If'
                            expression: { not: { equals: [ '@parameters(\'teamsWebhookUrl\')', '' ] } }
                            actions: {
                              Send_Teams_Success: {
                                type: 'Http'
                                inputs: {
                                  method: 'POST'
                                  uri: '@parameters(\'teamsWebhookUrl\')'
                                  headers: { 'Content-Type': 'application/json' }
                                  body: {
                                    type: 'message'
                                    attachments: [
                                      {
                                        contentType: 'application/vnd.microsoft.card.adaptive'
                                        contentUrl: null
                                        content: {
                                          '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                                          type: 'AdaptiveCard'
                                          version: '1.4'
                                          body: [
                                            {
                                              type: 'TextBlock'
                                              text: '✅ Deployment Succeeded'
                                              weight: 'Bolder'
                                              size: 'Large'
                                              color: 'Good'
                                            }
                                            {
                                              type: 'FactSet'
                                              facts: [
                                                { title: 'Deployment', value: '@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}' }
                                                { title: 'Region', value: '@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}' }
                                                { title: 'Attempts', value: '@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}' }
                                                { title: 'Completed', value: '@{utcNow()}' }
                                              ]
                                            }
                                          ]
                                        }
                                      }
                                    ]
                                  }
                                }
                                runAfter: {}
                              }
                            }
                            else: { actions: {} }
                            runAfter: {
                              Update_Blob_Succeeded: [ 'Succeeded' ]
                            }
                          }

                          Check_Email_Enabled_Success: {
                            type: 'If'
                            expression: { not: { equals: [ '@parameters(\'notificationEmail\')', '' ] } }
                            actions: {
                              Send_Email_Success: {
                                type: 'ApiConnection'
                                inputs: {
                                  host: {
                                    connection: {
                                      name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
                                    }
                                  }
                                  method: 'post'
                                  path: '/v2/Mail'
                                  body: {
                                    To: '@parameters(\'notificationEmail\')'
                                    Subject: '✅ Deployment Succeeded: @{body(\'Parse_Request_JSON\')?[\'deploymentName\']}'
                                    Body: '<h2>Deployment Succeeded</h2><table><tr><td><b>Deployment</b></td><td>@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}</td></tr><tr><td><b>Resource Group</b></td><td>@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}</td></tr><tr><td><b>Subscription</b></td><td>@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}</td></tr><tr><td><b>Attempts</b></td><td>@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}</td></tr><tr><td><b>Completed</b></td><td>@{utcNow()}</td></tr></table>'
                                    IsHtml: true
                                    Importance: 'Normal'
                                  }
                                }
                                runAfter: {}
                              }
                            }
                            else: { actions: {} }
                            runAfter: {
                              Update_Blob_Succeeded: [ 'Succeeded' ]
                            }
                          }
                        }
                        runAfter: {}
                      }

                      Catch_Deploy: {
                        type: 'Scope'
                        actions: {
                          Compose_Error_Body: {
                            type: 'Compose'
                            inputs: '@coalesce(body(\'Call_ARM_Deployment\'), outputs(\'Call_ARM_Deployment\'))'
                            runAfter: {}
                          }

                          Compose_Error_String: {
                            type: 'Compose'
                            inputs: '@toLower(string(outputs(\'Compose_Error_Body\')))'
                            runAfter: {
                              Compose_Error_Body: [ 'Succeeded' ]
                            }
                          }

                          Is_Capacity_Error: {
                            type: 'If'
                            expression: {
                              or: [
                                { contains: [ '@outputs(\'Compose_Error_String\')', 'allocationfailed' ] }
                                { contains: [ '@outputs(\'Compose_Error_String\')', 'skunotavailable' ] }
                                { contains: [ '@outputs(\'Compose_Error_String\')', 'insufficientcapacity' ] }
                                { contains: [ '@outputs(\'Compose_Error_String\')', 'quotaexceeded' ] }
                                { contains: [ '@outputs(\'Compose_Error_String\')', 'overconstrainedallocationrequest' ] }
                              ]
                            }
                            actions: {
                              Check_Max_Attempts: {
                                type: 'If'
                                expression: {
                                  less: [
                                    '@add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)'
                                    '@parameters(\'maxRetryAttempts\')'
                                  ]
                                }
                                actions: {
                                  Update_Blob_Retrying: {
                                    type: 'ApiConnection'
                                    inputs: {
                                      host: {
                                        connection: {
                                          name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                                        }
                                      }
                                      method: 'put'
                                      path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                      body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"retrying",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":"\', replace(string(outputs(\'Compose_Error_Body\')), \'"\', \'\\\\"\'  ), \'"\', \'}\'))'
                                    }
                                    runAfter: {}
                                  }

                                  Log_Retry_Scheduled: {
                                    type: 'Compose'
                                    inputs: {
                                      message: 'Capacity error — scheduling retry'
                                      deploymentName: '@body(\'Parse_Request_JSON\')?[\'deploymentName\']'
                                      attempt: '@add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)'
                                      nextRetryIn: '${retryIntervalMinutes} minutes'
                                      errorSummary: '@take(string(outputs(\'Compose_Error_Body\')), 500)'
                                    }
                                    runAfter: {
                                      Update_Blob_Retrying: [ 'Succeeded' ]
                                    }
                                  }
                                }
                                else: {
                                  actions: {
                                    Update_Blob_Max_Exceeded: {
                                      type: 'ApiConnection'
                                      inputs: {
                                        host: {
                                          connection: {
                                            name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                                          }
                                        }
                                        method: 'put'
                                        path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                        body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"failed",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":"Max retry attempts (\', string(parameters(\'maxRetryAttempts\')), \') exceeded. Last error: \', replace(take(string(outputs(\'Compose_Error_Body\')), 200), \'"\', \'\\\\"\'  ), \'"\', \'}\'))'
                                      }
                                      runAfter: {}
                                    }

                                    // Max-exceeded failure notifications
                                    Check_Teams_Enabled_Max_Fail: {
                                      type: 'If'
                                      expression: { not: { equals: [ '@parameters(\'teamsWebhookUrl\')', '' ] } }
                                      actions: {
                                        Send_Teams_Max_Failure: {
                                          type: 'Http'
                                          inputs: {
                                            method: 'POST'
                                            uri: '@parameters(\'teamsWebhookUrl\')'
                                            headers: { 'Content-Type': 'application/json' }
                                            body: {
                                              type: 'message'
                                              attachments: [
                                                {
                                                  contentType: 'application/vnd.microsoft.card.adaptive'
                                                  contentUrl: null
                                                  content: {
                                                    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                                                    type: 'AdaptiveCard'
                                                    version: '1.4'
                                                    body: [
                                                      {
                                                        type: 'TextBlock'
                                                        text: '❌ Deployment Failed (Max Retries Exceeded)'
                                                        weight: 'Bolder'
                                                        size: 'Large'
                                                        color: 'Attention'
                                                      }
                                                      {
                                                        type: 'FactSet'
                                                        facts: [
                                                          { title: 'Deployment', value: '@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}' }
                                                          { title: 'Resource Group', value: '@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}' }
                                                          { title: 'Attempts', value: '@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}' }
                                                          { title: 'Error', value: '@{take(string(outputs(\'Compose_Error_Body\')), 200)}' }
                                                        ]
                                                      }
                                                    ]
                                                  }
                                                }
                                              ]
                                            }
                                          }
                                          runAfter: {}
                                        }
                                      }
                                      else: { actions: {} }
                                      runAfter: {
                                        Update_Blob_Max_Exceeded: [ 'Succeeded' ]
                                      }
                                    }

                                    Check_Email_Enabled_Max_Fail: {
                                      type: 'If'
                                      expression: { not: { equals: [ '@parameters(\'notificationEmail\')', '' ] } }
                                      actions: {
                                        Send_Email_Max_Failure: {
                                          type: 'ApiConnection'
                                          inputs: {
                                            host: {
                                              connection: {
                                                name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
                                              }
                                            }
                                            method: 'post'
                                            path: '/v2/Mail'
                                            body: {
                                              To: '@parameters(\'notificationEmail\')'
                                              Subject: '❌ Deployment Failed (Max Retries): @{body(\'Parse_Request_JSON\')?[\'deploymentName\']}'
                                              Body: '<h2>Deployment Failed — Max Retries Exceeded</h2><table><tr><td><b>Deployment</b></td><td>@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}</td></tr><tr><td><b>Resource Group</b></td><td>@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}</td></tr><tr><td><b>Subscription</b></td><td>@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}</td></tr><tr><td><b>Attempts</b></td><td>@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}</td></tr><tr><td><b>Error</b></td><td>@{take(string(outputs(\'Compose_Error_Body\')), 500)}</td></tr></table>'
                                              IsHtml: true
                                              Importance: 'High'
                                            }
                                          }
                                          runAfter: {}
                                        }
                                      }
                                      else: { actions: {} }
                                      runAfter: {
                                        Update_Blob_Max_Exceeded: [ 'Succeeded' ]
                                      }
                                    }
                                  }
                                }
                                runAfter: {}
                              }
                            }
                            else: {
                              actions: {
                                Update_Blob_Failed: {
                                  type: 'ApiConnection'
                                  inputs: {
                                    host: {
                                      connection: {
                                        name: '@parameters(\'$connections\')[\'azureblob\'][\'connectionId\']'
                                      }
                                    }
                                    method: 'put'
                                    path: '/v2/datasets/@{encodeURIComponent(encodeURIComponent(parameters(\'storageAccountName\')))}/files/@{encodeURIComponent(items(\'For_Each_Blob\')?[\'Path\'])}'
                                    body: '@json(concat(\'{\', \'"deploymentName":"\', body(\'Parse_Request_JSON\')?[\'deploymentName\'], \'",\', \'"subscriptionId":"\', body(\'Parse_Request_JSON\')?[\'subscriptionId\'], \'",\', \'"resourceGroupName":"\', body(\'Parse_Request_JSON\')?[\'resourceGroupName\'], \'",\', \'"template":\', string(body(\'Parse_Request_JSON\')?[\'template\']), \',\', \'"parameters":\', string(body(\'Parse_Request_JSON\')?[\'parameters\']), \',\', \'"status":"failed",\', \'"attemptCount":\', string(add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)), \',\', \'"lastAttempt":"\', utcNow(), \'",\', \'"createdAt":"\', body(\'Parse_Request_JSON\')?[\'createdAt\'], \'",\', \'"lastError":"\', replace(take(string(outputs(\'Compose_Error_Body\')), 300), \'"\', \'\\\\"\'  ), \'"\', \'}\'))'
                                  }
                                  runAfter: {}
                                }

                                Log_Non_Retryable_Failure: {
                                  type: 'Compose'
                                  inputs: {
                                    message: 'Non-retryable deployment failure'
                                    deploymentName: '@body(\'Parse_Request_JSON\')?[\'deploymentName\']'
                                    attempt: '@add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)'
                                    error: '@take(string(outputs(\'Compose_Error_Body\')), 500)'
                                  }
                                  runAfter: {
                                    Update_Blob_Failed: [ 'Succeeded' ]
                                  }
                                }

                                // Non-capacity failure notifications
                                Check_Teams_Enabled_Fail: {
                                  type: 'If'
                                  expression: { not: { equals: [ '@parameters(\'teamsWebhookUrl\')', '' ] } }
                                  actions: {
                                    Send_Teams_Failure: {
                                      type: 'Http'
                                      inputs: {
                                        method: 'POST'
                                        uri: '@parameters(\'teamsWebhookUrl\')'
                                        headers: { 'Content-Type': 'application/json' }
                                        body: {
                                          type: 'message'
                                          attachments: [
                                            {
                                              contentType: 'application/vnd.microsoft.card.adaptive'
                                              contentUrl: null
                                              content: {
                                                '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                                                type: 'AdaptiveCard'
                                                version: '1.4'
                                                body: [
                                                  {
                                                    type: 'TextBlock'
                                                    text: '❌ Deployment Failed'
                                                    weight: 'Bolder'
                                                    size: 'Large'
                                                    color: 'Attention'
                                                  }
                                                  {
                                                    type: 'FactSet'
                                                    facts: [
                                                      { title: 'Deployment', value: '@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}' }
                                                      { title: 'Resource Group', value: '@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}' }
                                                      { title: 'Attempts', value: '@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}' }
                                                      { title: 'Error', value: '@{take(string(outputs(\'Compose_Error_Body\')), 200)}' }
                                                    ]
                                                  }
                                                ]
                                              }
                                            }
                                          ]
                                        }
                                      }
                                      runAfter: {}
                                    }
                                  }
                                  else: { actions: {} }
                                  runAfter: {
                                    Update_Blob_Failed: [ 'Succeeded' ]
                                  }
                                }

                                Check_Email_Enabled_Fail: {
                                  type: 'If'
                                  expression: { not: { equals: [ '@parameters(\'notificationEmail\')', '' ] } }
                                  actions: {
                                    Send_Email_Failure: {
                                      type: 'ApiConnection'
                                      inputs: {
                                        host: {
                                          connection: {
                                            name: '@parameters(\'$connections\')[\'office365\'][\'connectionId\']'
                                          }
                                        }
                                        method: 'post'
                                        path: '/v2/Mail'
                                        body: {
                                          To: '@parameters(\'notificationEmail\')'
                                          Subject: '❌ Deployment Failed: @{body(\'Parse_Request_JSON\')?[\'deploymentName\']}'
                                          Body: '<h2>Deployment Failed</h2><table><tr><td><b>Deployment</b></td><td>@{body(\'Parse_Request_JSON\')?[\'deploymentName\']}</td></tr><tr><td><b>Resource Group</b></td><td>@{body(\'Parse_Request_JSON\')?[\'resourceGroupName\']}</td></tr><tr><td><b>Subscription</b></td><td>@{body(\'Parse_Request_JSON\')?[\'subscriptionId\']}</td></tr><tr><td><b>Attempts</b></td><td>@{add(coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0), 1)}</td></tr><tr><td><b>Error</b></td><td>@{take(string(outputs(\'Compose_Error_Body\')), 500)}</td></tr></table>'
                                          IsHtml: true
                                          Importance: 'High'
                                        }
                                      }
                                      runAfter: {}
                                    }
                                  }
                                  else: { actions: {} }
                                  runAfter: {
                                    Update_Blob_Failed: [ 'Succeeded' ]
                                  }
                                }
                              }
                            }
                            runAfter: {
                              Compose_Error_String: [ 'Succeeded' ]
                            }
                          }
                        }
                        runAfter: {
                          Try_Deploy: [ 'Failed', 'TimedOut' ]
                        }
                      }
                    }
                  }
                  runAfter: {}
                }
              }
              else: {
                actions: {
                  Log_Skipped: {
                    type: 'Compose'
                    inputs: {
                      message: 'Skipped blob — status not actionable or max attempts reached'
                      blobPath: '@items(\'For_Each_Blob\')?[\'Path\']'
                      currentStatus: '@body(\'Parse_Request_JSON\')?[\'status\']'
                      attemptCount: '@coalesce(body(\'Parse_Request_JSON\')?[\'attemptCount\'], 0)'
                    }
                    runAfter: {}
                  }
                }
              }
              runAfter: {
                Parse_Request_JSON: [ 'Succeeded' ]
              }
            }
          }
          runAfter: {
            Filter_JSON_Blobs: [ 'Succeeded' ]
          }
          runtimeConfiguration: {
            concurrency: {
              repetitions: 1 // process one at a time to avoid ARM throttling
            }
          }
        }
      }
    }
    parameters: {
      '$connections': {
        value: union({
          azureblob: {
            connectionId: blobApiConnection.id
            connectionName: blobApiConnection.name
            connectionProperties: {
              authentication: {
                type: 'ManagedServiceIdentity'
              }
            }
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'azureblob')
          }
        }, enableEmail ? {
          office365: {
            connectionId: o365ApiConnection.id
            connectionName: o365ApiConnection.name
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'office365')
          }
        } : {})
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Role Assignments
// ---------------------------------------------------------------------------

// Storage Blob Data Contributor on the storage account for the Logic App MI
resource storageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, logicApp.id, storageBlobDataContributorRoleId)
  scope: storageAccount
  properties: {
    principalId: logicApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

// Contributor on the resource group for the Logic App MI (ARM deployments)
resource contributorRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, logicApp.id, contributorRoleId)
  properties: {
    principalId: logicApp.identity.principalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output staticWebAppUrl string = 'https://${staticWebApp.properties.defaultHostname}'
output staticWebAppName string = staticWebApp.name
output storageAccountName string = storageAccount.name
output logicAppName string = logicApp.name
output logicAppPrincipalId string = logicApp.identity.principalId
output blobContainerName string = blobContainerName
output notificationEmail string = notificationEmail
output teamsWebhookConfigured bool = enableTeams
