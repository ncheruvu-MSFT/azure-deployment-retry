// Polyfill crypto.randomUUID for Node < 19
const crypto = require('crypto');
if (!crypto.randomUUID) {
  crypto.randomUUID = () => {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  };
}
const { getRequest, updateRequest } = require("../shared/blobClient");

const CANCELLABLE_STATUSES = ["pending", "retrying"];

module.exports = async function (context, req) {
  try {
    const id = context.bindingData.id;

    if (!id) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request ID is required." },
      };
      return;
    }

    const request = await getRequest(id);

    if (!request) {
      context.res = {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: { error: `Request with ID '${id}' not found.` },
      };
      return;
    }

    if (!CANCELLABLE_STATUSES.includes(request.status)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Cannot cancel request with status '${request.status}'. Only requests with status 'pending' or 'retrying' can be cancelled.`,
        },
      };
      return;
    }

    const now = new Date().toISOString();
    const updated = await updateRequest(id, {
      status: "cancelled",
      updatedAt: now,
      completedAt: now,
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: updated,
    };
  } catch (err) {
    context.log.error("CancelRequest failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Internal server error. Failed to cancel request." },
    };
  }
};


