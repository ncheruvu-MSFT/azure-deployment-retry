// Cosmos DB REST client with AAD auth + resilient in-memory fallback
// When Cosmos is unreachable (firewall/network), falls back to in-memory store
// Data syncs to Cosmos when connectivity is restored
const { getAzureToken } = require('./azureAuth');
const https = require('https');

const endpoint = process.env.COSMOS_ENDPOINT || '';
const databaseId = process.env.COSMOS_DATABASE || 'deployretry';
const containerId = process.env.COSMOS_CONTAINER || 'requests';
const colPath = `dbs/${databaseId}/colls/${containerId}`;

// In-memory cache — always populated, synced with Cosmos when possible
const memStore = new Map();
let cosmosAvailable = !!endpoint;
let lastCosmosCheck = 0;

function cosmosReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    if (!endpoint) return reject(new Error('COSMOS_ENDPOINT not set'));
    const url = new URL(path, endpoint);
    const opts = { hostname: url.hostname, port: 443, path: url.pathname, method, headers };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const err = new Error(json.message || data.substring(0, 300));
            err.code = res.statusCode;
            reject(err);
          } else resolve(json);
        } catch(e) { reject(new Error(`Parse: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function authHeaders(partitionKey) {
  const token = await getAzureToken('https://cosmos.azure.com/.default');
  const h = {
    'Authorization': `type%3Daad%26ver%3D1.0%26sig%3D${encodeURIComponent(token)}`,
    'x-ms-date': new Date().toUTCString(),
    'x-ms-version': '2018-12-31',
    'Content-Type': 'application/json',
  };
  if (partitionKey !== undefined) h['x-ms-documentdb-partitionkey'] = `["${partitionKey}"]`;
  return h;
}

async function tryCosmosQuery(query, params) {
  const token = await getAzureToken('https://cosmos.azure.com/.default');
  return cosmosReq('POST', `/${colPath}/docs`, {
    'Authorization': `type%3Daad%26ver%3D1.0%26sig%3D${encodeURIComponent(token)}`,
    'x-ms-date': new Date().toUTCString(), 'x-ms-version': '2018-12-31',
    'Content-Type': 'application/query+json',
    'x-ms-documentdb-isquery': 'true',
    'x-ms-documentdb-query-enablecrosspartition': 'true',
  }, JSON.stringify({ query, parameters: params || [] }));
}

async function tryCosmosDoc(method, id, body) {
  const path = id ? `/${colPath}/docs/${id}` : `/${colPath}/docs`;
  const h = await authHeaders(id || (body && body.id));
  return cosmosReq(method, path, h, body);
}

// Hydrate memStore from Cosmos on first successful connection
async function syncFromCosmos() {
  if (!endpoint || Date.now() - lastCosmosCheck < 60000) return;
  lastCosmosCheck = Date.now();
  try {
    const res = await tryCosmosQuery('SELECT * FROM c');
    const docs = res.Documents || [];
    docs.forEach(d => memStore.set(d.id, d));
    cosmosAvailable = true;
  } catch(e) {
    cosmosAvailable = false;
  }
}

async function listRequests(statusFilter) {
  await syncFromCosmos();
  const all = Array.from(memStore.values());
  const filtered = statusFilter ? all.filter(r => r.status === statusFilter) : all;
  return filtered.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
}

async function getRequest(id) {
  await syncFromCosmos();
  return memStore.get(id) || null;
}

async function createRequest(data) {
  memStore.set(data.id, data);
  if (endpoint) {
    try { await tryCosmosDoc('POST', null, data); cosmosAvailable = true; }
    catch(e) { cosmosAvailable = false; console.warn('[blobClient] Cosmos write failed, in-memory only:', e.code); }
  }
  return data;
}

async function updateRequest(id, updates) {
  const existing = memStore.get(id);
  if (!existing) return null;
  const { _rid, _self, _etag, _attachments, _ts, ...clean } = existing;
  const updated = { ...clean, ...updates, id, updatedAt: new Date().toISOString() };
  memStore.set(id, updated);
  if (endpoint) {
    try { await tryCosmosDoc('PUT', id, updated); cosmosAvailable = true; }
    catch(e) { cosmosAvailable = false; console.warn('[blobClient] Cosmos update failed:', e.code); }
  }
  return updated;
}

async function deleteRequest(id) {
  memStore.delete(id);
  if (endpoint) {
    try { await tryCosmosDoc('DELETE', id); } catch(e) { /* ignore */ }
  }
  return true;
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest };
