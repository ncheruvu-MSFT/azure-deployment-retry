const { getAzureToken } = require("../shared/azureAuth");
const { armRequest } = require("../shared/armClient");

const GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function (context, req) {
  try {
    const subscriptionId = (req.query.subscriptionId || "").trim();
    const resourceGroup = (req.query.resourceGroup || "").trim();

    if (!subscriptionId || !GUID_REGEX.test(subscriptionId)) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "subscriptionId query parameter is required and must be a valid GUID." },
      };
      return;
    }

    const token = await getAzureToken();

    // If no resource group provided, return list of RGs
    if (!resourceGroup) {
      const rgResult = await armRequest(
        "GET",
        `/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`,
        token
      );

      const resourceGroups = (rgResult.value || []).map((rg) => ({
        name: rg.name,
        location: rg.location,
        provisioningState: rg.properties?.provisioningState || null,
      }));

      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { type: "resourceGroups", items: resourceGroups },
      };
      return;
    }

    // Fetch failed deployments for the given RG
    const filterPath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments?%24filter=provisioningState%20eq%20%27Failed%27&api-version=2021-04-01`;
    const deploymentsResult = await armRequest(
      "GET",
      filterPath,
      token
    );

    const deployments = deploymentsResult.value || [];

    // For each failed deployment, fetch the exported template
    const results = await Promise.all(
      deployments.map(async (dep) => {
        const name = dep.name;
        const props = dep.properties || {};
        const error = props.error || {};

        let templateExport = null;
        try {
          templateExport = await armRequest(
            "POST",
            `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${name}/exportTemplate?api-version=2021-04-01`,
            token
          );
        } catch (exportErr) {
          context.log.warn(`Failed to export template for ${name}: ${exportErr.message}`);
          templateExport = { error: exportErr.message };
        }

        return {
          name: name,
          timestamp: props.timestamp || null,
          errorCode: error.code || null,
          errorMessage: error.message || null,
          correlationId: props.correlationId || null,
          templateUri: props.templateLink?.uri || null,
          template: templateExport?.template || null,
          parameters: props.parameters || null,
        };
      })
    );

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { type: "failedDeployments", items: results },
    };
  } catch (err) {
    context.log.error("FailedDeployments failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Failed to fetch deployments.", detail: (err.message || "").substring(0, 500) },
    };
  }
};
