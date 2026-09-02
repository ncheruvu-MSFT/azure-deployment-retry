const { getAzureToken } = require("../shared/azureAuth");
const { preFlightCheck } = require("../shared/quotaCheck");

module.exports = async function (context, req) {
  try {
    const subscriptionId = (req.query.subscriptionId || "").trim();
    const region = (req.query.region || "").trim();
    const vmSku = (req.query.vmSku || "").trim();

    if (!subscriptionId || !region) {
      context.res = {
        status: 400,
        headers: { "Content-Type": "application/json" },
        body: { error: "subscriptionId and region query parameters are required." },
      };
      return;
    }

    const token = await getAzureToken();
    const result = await preFlightCheck(token, subscriptionId, region, vmSku);

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: result,
    };
  } catch (err) {
    context.log.error("CheckQuota failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Quota check failed.", detail: (err.message || "").substring(0, 500) },
    };
  }
};
