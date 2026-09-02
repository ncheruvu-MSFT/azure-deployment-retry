// Cosmos DB REST client using AAD token auth (zero SDK, Node 16+)
const { getAzureToken } = require('./azureAuth');
const https = require('https');

const endpoint = process.env.COSMOS_ENDPOINT || '';
const databaseId = process.env.COSMOS_DATABASE || 'deployretry';
const containerId = process.env.COSMOS_CONTAINER || 'requests';
const colPath = `dbs/${databaseId}/colls/${containerId}`;

// Use in-memory fallback when Cosmos is not configured
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
        } catch(e) { reject(new Error(data.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function cosmosQuery(query, params) {
  const token = await getAzureToken('https://cosmos.azure.com/.default');
  const date = new Date().toUTCString();
  return cosmosReq('POST', `/${colPath}/docs`, {
    'Authorization': `type%3Daad%26ver%3D1.0%26sig%3D${encodeURIComponent(token)}`,
    'x-ms-date': date, 'x-ms-version': '2018-12-31',
    'Content-Type': 'application/query+json',
    'x-ms-documentdb-isquery': 'true',
    'x-ms-documentdb-query-enablecrosspartition': 'true',
  }, JSON.stringify({ query, parameters: params || [] }));
}

async function cosmosDoc(method, id, body) {
  const token = await getAzureToken('https://cosmos.azure.com/.default');
  const date = new Date().toUTCString();
  const path = id ? `/${colPath}/docs/${id}` : `/${colPath}/docs`;
  const headers = {
    'Authorization': `type%3Daad%26ver%3D1.0%26sig%3D${encodeURIComponent(token)}`,
    'x-ms-date': date, 'x-ms-version': '2018-12-31',
    'Content-Type': 'application/json',
  };
  if (id) headers['x-ms-documentdb-partitionkey'] = `["${id}"]`;
  return cosmosReq(method, path, headers, body);
}

async function listRequests(statusFilter) {
  if (useMemory) {
    const all = Array.from(memStore.values());
    return statusFilter ? all.filter(r => r.status === statusFilter) : all.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
  }
  let q = 'SELECT * FROM c ORDER BY c.createdAt DESC';
  const p = [];
  if (statusFilter) { q = 'SELECT * FROM c WHERE c.status = @s ORDER BY c.createdAt DESC'; p.push({name:'@s',value:statusFilter}); }
  const res = await cosmosQuery(q, p);
  return res.Documents || [];
}

async function getRequest(id) {
  if (useMemory) return memStore.get(id) || null;
  try { return await cosmosDoc('GET', id); } catch(e) { if (e.code === 404) return null; throw e; }
}

async function createRequest(data) {
  if (useMemory) { memStore.set(data.id, data); return data; }
  return await cosmosDoc('POST', null, data);
}

async function updateRequest(id, updates) {
  const existing = await getRequest(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates, id };
  if (useMemory) { memStore.set(id, updated); return updated; }
  return await cosmosDoc('PUT', id, updated);
}

async function deleteRequest(id) {
  if (useMemory) return memStore.delete(id);
  try { await cosmosDoc('DELETE', id); return true; } catch(e) { if (e.code === 404) return false; throw e; }
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest };
