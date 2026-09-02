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
const { listRequests } = require("../shared/blobClient");

module.exports = async function (context, req) {
  try {
    const statusFilter = req.query.status || null;

    // Validate status filter if provided
    const validStatuses = [
      "pending",
      "retrying",
      "succeeded",
      "failed",
      "cancelled",
    ];
    if (statusFilter && !validStatuses.includes(statusFilter)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Invalid status filter. Must be one of: ${validStatuses.join(", ")}`,
        },
      };
      return;
    }

    const requests = await listRequests(statusFilter);

    // Sort by createdAt descending (newest first)
    requests.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Strip full templateContent for lighter responses; include a preview
    const summary = requests.map((r) => {
      const { templateContent, ...rest } = r;
      return {
        ...rest,
        templatePreview: templateContent
          ? templateContent.substring(0, 200)
          : null,
      };
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: summary,
    };
  } catch (err) {
    context.log.error("GetRequests failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Failed to list requests.", detail: err.code + ": " + (err.message || "").substring(0, 500) },
    };
  }
};


