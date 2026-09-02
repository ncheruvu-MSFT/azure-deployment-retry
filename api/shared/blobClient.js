// In-memory store with optional Cosmos DB backend
// Falls back to in-memory when Cosmos is unreachable (demo mode)
const store = new Map();

async function listRequests(statusFilter) {
  const all = Array.from(store.values());
  if (statusFilter) return all.filter(r => r.status === statusFilter);
  return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

async function getRequest(id) {
  return store.get(id) || null;
}

async function createRequest(requestData) {
  store.set(requestData.id, requestData);
  return requestData;
}

async function updateRequest(id, updates) {
  const existing = store.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates, id };
  store.set(id, updated);
  return updated;
}

async function deleteRequest(id) {
  return store.delete(id);
}

module.exports = { listRequests, getRequest, createRequest, updateRequest, deleteRequest };
