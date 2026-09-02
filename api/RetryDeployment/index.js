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
const { getAzureToken } = require("../shared/azureAuth");
const { armRequest } = require("../shared/armClient");

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const { subscriptionId, resourceGroup, deploymentName, retryIntervalMinutes } = body;

    if (!subscriptionId || !GUID_REGEX.test(subscriptionId)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "subscriptionId is required and must be a valid GUID." },
      };
      return;
    }

    if (!resourceGroup || !resourceGroup.trim()) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "resourceGroup is required." },
      };
      return;
    }

    if (!deploymentName || !deploymentName.trim()) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "deploymentName is required." },
      };
      return;
    }

    // Fetch the failed deployment's template and parameters from ARM
    const token = await getAzureToken();

    let templateExport;
    try {
      templateExport = await armRequest(
        "POST",
        `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${deploymentName}/exportTemplate?api-version=2021-04-01`,
        token
      );
    } catch (exportErr) {
      context.log.warn(`Failed to export template for ${deploymentName}: ${exportErr.message}`);
      templateExport = {};
    }

    // Also fetch the deployment itself for parameters and metadata
    let deployment;
    try {
      deployment = await armRequest(
        "GET",
        `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`,
        token
      );
    } catch (depErr) {
      context.log.warn(`Failed to fetch deployment ${deploymentName}: ${depErr.message}`);
      deployment = {};
    }

    const props = deployment.properties || {};
    const template = templateExport.template || {};
    const templateContent = template
      ? JSON.stringify(template, null, 2)
      : JSON.stringify({ note: "Template export unavailable" });

    // Extract region from: body override > deployment parameters > RG location > resource location
    const resources = template.resources || [];
    const firstResource = resources[0] || {};
    let region = body.region
      || (props.parameters?.location?.value)
      || firstResource.location
      || "unknown";

    // If region is an ARM expression or still unknown, resolve from RG
    if (!region || region === "unknown" || (region.startsWith && region.startsWith("["))) {
      try {
        const rgInfo = await armRequest("GET",
          `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}?api-version=2021-04-01`, token);
        region = rgInfo.location || "unknown";
      } catch(e) { region = "unknown"; }
    }

    // Extract SKU from: body override > template resource SKU > model name
    let vmSku = body.vmSku || "";
    if (!vmSku) {
      if (firstResource.sku?.name) {
        vmSku = firstResource.sku.name;
        if (firstResource.sku.capacity) vmSku += ` (${firstResource.sku.capacity})`;
      }
      if (firstResource.properties?.model?.name) {
        vmSku = firstResource.properties.model.name;
        if (firstResource.properties.model.version) vmSku += ` v${firstResource.properties.model.version}`;
      }
      if (firstResource.properties?.hardwareProfile?.vmSize) {
        vmSku = firstResource.properties.hardwareProfile.vmSize;
      }
      if (!vmSku) vmSku = firstResource.type || "imported";
    }

    // Extract error details
    const error = props.error || {};
    const errorDetail = error.details?.[0] || {};
    const errorCode = errorDetail.code || error.code || "";
    const errorMessage = errorDetail.message || error.message || "";

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const requestData = {
      id,
      deploymentName: deploymentName.trim(),
      subscriptionId: subscriptionId.trim(),
      resourceGroup: resourceGroup.trim(),
      region: region,
      vmSku: vmSku,
      templateType: "arm",
      templateContent: templateContent,
      templateParameters: props.parameters || {},
      priority: body.priority || "normal",
      notes: `Imported from failed deployment: ${deploymentName}. Error: ${errorCode} — ${errorMessage.substring(0, 200)}`,
      notifyEmail: body.notifyEmail || "",
      notifyTeams: body.notifyTeams || "",
      status: "pending",
      attemptCount: 0,
      maxAttempts: body.maxAttempts || 432,
      retryIntervalMinutes: retryIntervalMinutes || 10,
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
    context.log.error("RetryDeployment failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Internal server error. Failed to create retry request.", detail: (err.message || "").substring(0, 500) },
    };
  }
};

