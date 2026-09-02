// Persistent state store using GitHub API
// Writes state.json to the repo — survives all redeploys
const https = require('https');

const GH_TOKEN = process.env.GITHUB_STATE_TOKEN;
const GH_REPO = process.env.GITHUB_STATE_REPO || 'ncheruvu-MSFT/azure-deployment-retry';
const GH_PATH = process.env.GITHUB_STATE_PATH || 'state/requests.json';

// In-memory cache
let store = new Map();
let lastSha = null;
let loaded = false;
let saving = false;

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com', port: 443, method,
      path: `/repos/${GH_REPO}/contents/${path}`,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'deploy-retry-platform',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400 && res.statusCode !== 404) {
            const err = new Error(json.message || `GitHub ${res.statusCode}`);
            err.code = res.statusCode;
            reject(err);
          } else resolve({ status: res.statusCode, body: json });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function loadFromGitHub() {
  if (loaded || !GH_TOKEN) return;
  try {
    const { status, body } = await ghRequest('GET', GH_PATH);
    if (status === 200 && body.content) {
      const json = Buffer.from(body.content, 'base64').toString('utf8');
      const items = JSON.parse(json);
      items.forEach(item => store.set(item.id, item));
      lastSha = body.sha;
      loaded = true;
    } else if (status === 404) {
      loaded = true; // file doesn't exist yet, start empty
    }
  } catch(e) {
    console.warn('[state] GitHub load failed:', e.message);
    loaded = true; // don't retry every request
  }
}

async function saveToGitHub() {
  if (!GH_TOKEN || saving) return;
  saving = true;
  try {
    const items = Array.from(store.values());
    const content = Buffer.from(JSON.stringify(items, null, 2)).toString('base64');
    const body = {
      message: `Update state: ${items.length} requests`,
      content,
      committer: { name: 'Deploy Retry Bot', email: 'bot@deploy-retry.azure' },
    };
    if (lastSha) body.sha = lastSha;
    const { status, body: resp } = await ghRequest('PUT', GH_PATH, body);
    if (status === 200 || status === 201) {
      lastSha = resp.content?.sha;
    }
  } catch(e) {
    console.warn('[state] GitHub save failed:', e.message);
  } finally {
    saving = false;
  }
}

async function listRequests(statusFilter) {
  await loadFromGitHub();
  const all = Array.from(store.values());
  const filtered = statusFilter ? all.filter(r => r.status === statusFilter) : all;
  return filtered.sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
}

async function getRequest(id) {
  await loadFromGitHub();
  return store.get(id) || null;
}

async function createRequest(data) {
  await loadFromGitHub();
  store.set(data.id, data);
  await saveToGitHub();
  return data;
}

async function updateRequest(id, updates) {
  await loadFromGitHub();
  const existing = store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  store.set(id, updated);
  await saveToGitHub();
  return updated;
}

async function deleteRequest(id) {
  await loadFromGitHub();
  store.delete(id);
  await saveToGitHub();
  return true;
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest };
