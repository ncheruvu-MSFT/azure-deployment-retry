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
const { createRequest } = require("../shared/blobClient");

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TEMPLATE_TYPES = ["arm", "bicep", "terraform"];
const VALID_PRIORITIES = ["normal", "high"];

module.exports = async function (context, req) {
  try {
    const body = req.body;

    if (!body || typeof body !== "object") {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "Request body is required and must be a JSON object." },
      };
      return;
    }

    // Validate required fields
    const requiredFields = [
      "deploymentName",
      "subscriptionId",
      "resourceGroup",
      "region",
      "vmSku",
      "templateType",
      "templateContent",
    ];
    const missingFields = requiredFields.filter(
      (f) => !body[f] || (typeof body[f] === "string" && !body[f].trim())
    );

    if (missingFields.length > 0) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `Missing required fields: ${missingFields.join(", ")}`,
        },
      };
      return;
    }

    // Validate subscriptionId is a GUID
    if (!GUID_REGEX.test(body.subscriptionId)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error:
            "subscriptionId must be a valid GUID (e.g., 12345678-1234-1234-1234-123456789abc).",
        },
      };
      return;
    }

    // Validate templateType
    if (!VALID_TEMPLATE_TYPES.includes(body.templateType)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `templateType must be one of: ${VALID_TEMPLATE_TYPES.join(", ")}`,
        },
      };
      return;
    }

    // Validate priority if provided
    const priority = body.priority || "normal";
    if (!VALID_PRIORITIES.includes(priority)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: {
          error: `priority must be one of: ${VALID_PRIORITIES.join(", ")}`,
        },
      };
      return;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const requestData = {
      id,
      deploymentName: body.deploymentName.trim(),
      subscriptionId: body.subscriptionId.trim(),
      resourceGroup: body.resourceGroup.trim(),
      region: body.region.trim(),
      vmSku: body.vmSku.trim(),
      templateType: body.templateType,
      templateContent: body.templateContent,
      templateParameters: body.templateParameters || {},
      priority,
      notes: body.notes || "",
      notifyEmail: body.notifyEmail || "",
      notifyTeams: body.notifyTeams || "",
      status: "pending",
      attemptCount: 0,
      maxAttempts: body.maxAttempts || 432,
      retryIntervalMinutes: body.retryIntervalMinutes || 10,
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      completedAt: null,
      attempts: [],
      lastError: null,
    };

    const created = await createRequest(requestData);

    context.res = {
      status: 201,
      headers: { "Content-Type": "application/json" },
      body: created,
    };
  } catch (err) {
    context.log.error("SubmitRequest failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Failed to create request.", detail: (err.message || "").substring(0, 500) },
    };
  }
};




