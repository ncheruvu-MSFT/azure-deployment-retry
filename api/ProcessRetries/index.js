const { listRequests, updateRequest } = require("../shared/blobClient");
const { getAzureToken } = require("../shared/azureAuth");
const { armRequest } = require("../shared/armClient");
const { preFlightCheck } = require("../shared/quotaCheck");

// Capacity error patterns — these get retried
const CAPACITY_PATTERNS = [
  "allocationfailed", "skunotavailable", "insufficientcapacity",
  "quotaexceeded", "overconstrainedallocationrequest",
  "insufficientquota", "operationnotallowed",
];

function isCapacityError(errorStr) {
  const lower = (errorStr || "").toLowerCase();
  return CAPACITY_PATTERNS.some((p) => lower.includes(p));
}

module.exports = async function (context, req) {
  const results = { processed: 0, retried: 0, succeeded: 0, failed: 0, skipped: 0, errors: [] };

  try {
    // Get all pending/retrying requests
    const allRequests = await listRequests();
    const actionable = allRequests.filter(
      (r) => r.status === "pending" || r.status === "retrying"
    );

    if (actionable.length === 0) {
      context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { message: "No actionable requests.", ...results } };
      return;
    }

    const token = await getAzureToken();

    for (const request of actionable) {
      results.processed++;

      // Skip if max attempts exceeded
      if ((request.attemptCount || 0) >= (request.maxAttempts || 432)) {
        await updateRequest(request.id, {
          status: "failed",
          lastError: { code: "MaxAttemptsExceeded", message: `Exceeded ${request.maxAttempts} retry attempts` },
          completedAt: new Date().toISOString(),
        });
        results.failed++;
        continue;
      }

      // Skip if last attempt was less than retryIntervalMinutes ago (prevent overlap)
      const interval = (request.retryIntervalMinutes || 10) * 60 * 1000;
      if (request.lastAttemptAt) {
        const elapsed = Date.now() - new Date(request.lastAttemptAt).getTime();
        if (elapsed < interval) {
          results.skipped++;
          continue;
        }
      }

      // Skip if there's an in-progress ARM deployment for this request
      try {
        const depStatus = await armRequest("GET",
          `/subscriptions/${request.subscriptionId}/resourceGroups/${request.resourceGroup}/providers/Microsoft.Resources/deployments/${request.deploymentName}?api-version=2021-04-01`,
          token);
        const state = depStatus.properties?.provisioningState;
        if (state === "Running" || state === "Accepted") {
          // Deployment is still in progress — skip this cycle
          await updateRequest(request.id, { status: "retrying", lastAttemptAt: new Date().toISOString() });
          results.skipped++;
          continue;
        }
      } catch (e) {
        // 404 = no existing deployment, proceed with retry
        if (e.statusCode !== 404) {
          context.log.warn(`Failed to check deployment status for ${request.deploymentName}: ${e.message}`);
        }
      }

      // Pre-flight: check SKU availability and quota before attempting deployment
      const preflight = await preFlightCheck(token, request.subscriptionId, request.region, request.vmSku);
      if (!preflight.canRetry) {
        const reasons = preflight.checks.filter(c => c.available === false || c.withinQuota === false).map(c => c.reason).join('; ');
        attempt.result = "quota_blocked";
        attempt.errorCode = "QuotaPreCheckFailed";
        attempt.errorMessage = reasons;
        const attempts = [...(request.attempts || []), attempt];
        await updateRequest(request.id, {
          status: "retrying",
          attemptCount: attemptNumber,
          lastAttemptAt: now,
          attempts,
          lastError: { code: "QuotaPreCheckFailed", message: `Skipped: ${reasons}` },
          preflightChecks: preflight.checks,
        });
        results.skipped++;
        continue;
      }

      // Attempt the deployment
      const attemptNumber = (request.attemptCount || 0) + 1;
      const now = new Date().toISOString();
      const attempt = { attemptNumber, timestamp: now, result: null, errorCode: null, errorMessage: null };

      try {
        let templateObj;
        try { templateObj = JSON.parse(request.templateContent); } catch(e) {
          attempt.result = "failed";
          attempt.errorCode = "InvalidTemplate";
          attempt.errorMessage = "Failed to parse template JSON";
          const attempts = [...(request.attempts || []), attempt];
          await updateRequest(request.id, { status: "failed", attemptCount: attemptNumber, lastAttemptAt: now, completedAt: now, attempts, lastError: { code: "InvalidTemplate", message: attempt.errorMessage } });
          results.failed++;
          continue;
        }

        // Submit ARM deployment with a unique name to avoid conflicts
        const deploymentName = `${request.deploymentName}-retry-${attemptNumber}`;
        await armRequest("PUT",
          `/subscriptions/${request.subscriptionId}/resourceGroups/${request.resourceGroup}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`,
          token,
          { properties: { mode: "Incremental", template: templateObj, parameters: request.templateParameters || {} } }
        );

        // ARM accepted the request — poll for actual completion (up to 60s)
        let finalState = "Running";
        let pollError = null;
        for (let poll = 0; poll < 6; poll++) {
          await new Promise(r => setTimeout(r, 10000)); // wait 10s between polls
          try {
            const depStatus = await armRequest("GET",
              `/subscriptions/${request.subscriptionId}/resourceGroups/${request.resourceGroup}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2021-04-01`,
              token);
            finalState = depStatus.properties?.provisioningState || "Unknown";
            if (finalState === "Succeeded" || finalState === "Failed" || finalState === "Canceled") {
              if (finalState === "Failed") {
                const depErr = depStatus.properties?.error || {};
                pollError = {
                  code: depErr.details?.[0]?.code || depErr.code || "DeploymentFailed",
                  message: depErr.details?.[0]?.message || depErr.message || "Deployment failed"
                };
              }
              break;
            }
          } catch(pollErr) { break; } // can't check status, treat as in-progress
        }

        if (finalState === "Succeeded") {
          attempt.result = "succeeded";
          const attempts = [...(request.attempts || []), attempt];
          await updateRequest(request.id, {
            status: "succeeded", attemptCount: attemptNumber, lastAttemptAt: now,
            completedAt: new Date().toISOString(), attempts, lastError: null,
          });
          results.succeeded++;
        } else if (finalState === "Failed" && pollError) {
          const fullError = `${pollError.code}: ${pollError.message}`;
          attempt.result = isCapacityError(fullError) ? "capacity_error" : "failed";
          attempt.errorCode = pollError.code;
          attempt.errorMessage = pollError.message.substring(0, 500);
          const attempts = [...(request.attempts || []), attempt];
          if (isCapacityError(fullError)) {
            await updateRequest(request.id, {
              status: "retrying", attemptCount: attemptNumber, lastAttemptAt: now,
              attempts, lastError: pollError,
            });
            results.retried++;
          } else {
            await updateRequest(request.id, {
              status: "failed", attemptCount: attemptNumber, lastAttemptAt: now,
              completedAt: new Date().toISOString(), attempts, lastError: pollError,
            });
            results.failed++;
          }
        } else {
          // Still running after 60s — mark as retrying, check next cycle
          attempt.result = "in_progress";
          const attempts = [...(request.attempts || []), attempt];
          await updateRequest(request.id, {
            status: "retrying", attemptCount: attemptNumber, lastAttemptAt: now, attempts,
          });
          results.retried++;
        }
      } catch (deployErr) {
        const errMsg = deployErr.message || "";
        const errBody = deployErr.body?.error || {};
        const errCode = errBody.code || "";
        const fullError = `${errCode}: ${errBody.message || errMsg}`;

        attempt.result = isCapacityError(fullError) ? "capacity_error" : "failed";
        attempt.errorCode = errCode || "DeploymentFailed";
        attempt.errorMessage = (errBody.message || errMsg).substring(0, 500);

        const attempts = [...(request.attempts || []), attempt];

        if (isCapacityError(fullError)) {
          // Capacity error — mark retrying, will try again next cycle
          await updateRequest(request.id, {
            status: "retrying",
            attemptCount: attemptNumber,
            lastAttemptAt: now,
            attempts,
            lastError: { code: attempt.errorCode, message: attempt.errorMessage },
          });
          results.retried++;
        } else {
          // Non-capacity error — fail permanently
          await updateRequest(request.id, {
            status: "failed",
            attemptCount: attemptNumber,
            lastAttemptAt: now,
            completedAt: now,
            attempts,
            lastError: { code: attempt.errorCode, message: attempt.errorMessage },
          });
          results.failed++;
        }
      }
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { message: "Retry processing complete.", ...results },
    };
  } catch (err) {
    context.log.error("ProcessRetries failed:", err.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "Failed to process retries.", detail: (err.message || "").substring(0, 500) },
    };
  }
};
