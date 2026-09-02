// Cosmos DB REST client with AAD token auth — zero SDK, Node 16+ compatible
const { getAzureToken } = require('./azureAuth');
const https = require('https');

const endpoint = process.env.COSMOS_ENDPOINT || '';
const databaseId = process.env.COSMOS_DATABASE || 'deployretry';
const containerId = process.env.COSMOS_CONTAINER || 'requests';
const colPath = `dbs/${databaseId}/colls/${containerId}`;

if (!endpoint) console.warn('[blobClient] COSMOS_ENDPOINT not set — data will NOT persist across restarts');

// In-memory fallback ONLY when Cosmos is not configured at all
const memStore = new Map();
const useMemory = !endpoint;

function cosmosReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
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
        } catch(e) { reject(new Error(`Parse error: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Cosmos request timed out')); });
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

async function listRequests(statusFilter) {
  if (useMemory) {
    const all = Array.from(memStore.values());
    const filtered = statusFilter ? all.filter(r => r.status === statusFilter) : all;
    return filtered.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
  }
  let q = 'SELECT * FROM c ORDER BY c.createdAt DESC';
  const p = [];
  if (statusFilter) {
    q = 'SELECT * FROM c WHERE c.status = @s ORDER BY c.createdAt DESC';
    p.push({ name: '@s', value: statusFilter });
  }
  const token = await getAzureToken('https://cosmos.azure.com/.default');
  const res = await cosmosReq('POST', `/${colPath}/docs`, {
    'Authorization': `type%3Daad%26ver%3D1.0%26sig%3D${encodeURIComponent(token)}`,
    'x-ms-date': new Date().toUTCString(), 'x-ms-version': '2018-12-31',
    'Content-Type': 'application/query+json',
    'x-ms-documentdb-isquery': 'true',
    'x-ms-documentdb-query-enablecrosspartition': 'true',
  }, JSON.stringify({ query: q, parameters: p }));
  return res.Documents || [];
}

async function getRequest(id) {
  if (useMemory) return memStore.get(id) || null;
  try {
    const h = await authHeaders(id);
    return await cosmosReq('GET', `/${colPath}/docs/${id}`, h);
  } catch(e) { if (e.code === 404) return null; throw e; }
}

async function createRequest(data) {
  if (useMemory) { memStore.set(data.id, data); return data; }
  const h = await authHeaders(data.id);
  return await cosmosReq('POST', `/${colPath}/docs`, h, data);
}

async function updateRequest(id, updates) {
  const existing = await getRequest(id);
  if (!existing) return null;
  // Remove Cosmos system properties before replacing
  const { _rid, _self, _etag, _attachments, _ts, ...clean } = existing;
  const updated = { ...clean, ...updates, id, updatedAt: new Date().toISOString() };
  if (useMemory) { memStore.set(id, updated); return updated; }
  const h = await authHeaders(id);
  return await cosmosReq('PUT', `/${colPath}/docs/${id}`, h, updated);
}

async function deleteRequest(id) {
  if (useMemory) return memStore.delete(id);
  try {
    const h = await authHeaders(id);
    await cosmosReq('DELETE', `/${colPath}/docs/${id}`, h);
    return true;
  } catch(e) { if (e.code === 404) return false; throw e; }
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest };
