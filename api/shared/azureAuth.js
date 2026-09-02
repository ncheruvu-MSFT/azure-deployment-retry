const https = require('https');
const querystring = require('querystring');

let cachedTokens = {};

/**
 * Get an AAD token for the given resource scope.
 * Supports two modes:
 *   1. Workload Identity Federation (AZURE_FEDERATED_TOKEN_FILE) — recommended, no secrets
 *   2. Client Secret (AZURE_CLIENT_SECRET) — fallback
 * Caches tokens per-resource until 60s before expiry.
 */
function getAzureToken(resource) {
  resource = resource || 'https://management.azure.com/.default';

  const cached = cachedTokens[resource];
  if (cached && Date.now() < cached.expiry - 60000) {
    return Promise.resolve(cached.token);
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const federatedTokenFile = process.env.AZURE_FEDERATED_TOKEN_FILE;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  if (!tenantId || !clientId) {
    return Promise.reject(new Error('Missing AZURE_TENANT_ID or AZURE_CLIENT_ID environment variables.'));
  }

  let postData;

  if (federatedTokenFile) {
    // Workload Identity Federation — read the projected token and exchange it
    const fs = require('fs');
    const assertion = fs.readFileSync(federatedTokenFile, 'utf8').trim();
    postData = querystring.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      client_id: clientId,
      assertion: assertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      scope: resource,
      requested_token_use: 'on_behalf_of',
    });
  } else if (clientSecret) {
    // Client credentials with secret — fallback
    postData = querystring.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: resource,
    });
  } else {
    return Promise.reject(new Error('No credential found. Set AZURE_FEDERATED_TOKEN_FILE (recommended) or AZURE_CLIENT_SECRET.'));
  }

  const options = {
    hostname: 'login.microsoftonline.com',
    path: `/${tenantId}/oauth2/v2.0/token`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.access_token) {
            cachedTokens[resource] = {
              token: json.access_token,
              expiry: Date.now() + (json.expires_in * 1000),
            };
            resolve(json.access_token);
          } else {
            reject(new Error(`Token request failed: ${json.error_description || json.error || body}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse token response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { getAzureToken };
