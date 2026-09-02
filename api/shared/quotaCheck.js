// Quota pre-check before retrying deployments
// Checks VM SKU availability and compute/AI quota in the target region
const { armRequest } = require('./armClient');

/**
 * Check if a VM SKU is available in the target region.
 * Returns { available, reason } — if not available, reason explains why.
 */
async function checkSkuAvailability(token, subscriptionId, region, vmSku) {
  if (!vmSku || vmSku === 'imported' || vmSku.includes('gpt-') || vmSku.includes('OpenAI')) {
    // AI model deployments — skip VM SKU check, use quota check instead
    return { available: true, reason: 'AI model — SKU check not applicable' };
  }

  try {
    const result = await armRequest('GET',
      `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=location eq '${region}'`,
      token);

    const skus = result.value || [];
    const match = skus.find(s => s.name && s.name.toLowerCase() === vmSku.toLowerCase());

    if (!match) {
      return { available: false, reason: `SKU ${vmSku} not found in region ${region}` };
    }

    // Check restrictions
    const restrictions = match.restrictions || [];
    const zoneRestrictions = restrictions.filter(r => r.type === 'Zone');
    const locationRestrictions = restrictions.filter(r => r.type === 'Location');

    if (locationRestrictions.length > 0) {
      const restrictedRegions = locationRestrictions.flatMap(r => r.restrictionInfo?.locations || []);
      if (restrictedRegions.some(loc => loc.toLowerCase() === region.toLowerCase())) {
        return { available: false, reason: `SKU ${vmSku} is restricted in region ${region}. Request quota increase.` };
      }
    }

    return {
      available: true,
      reason: `SKU ${vmSku} available in ${region}`,
      zones: zoneRestrictions.length > 0 ? 'Some availability zones restricted' : 'All zones available',
    };
  } catch (e) {
    // Can't check — allow retry anyway
    return { available: true, reason: `SKU check failed: ${e.message}. Proceeding with retry.`, warning: true };
  }
}

/**
 * Check compute quota usage for the VM family in the target region.
 * Returns { withinQuota, usage, limit, reason }
 */
async function checkComputeQuota(token, subscriptionId, region, vmSku) {
  if (!vmSku || vmSku === 'imported') {
    return { withinQuota: true, reason: 'No SKU specified — skipping quota check' };
  }

  // AI model deployments — check Cognitive Services quota
  if (vmSku.includes('gpt-') || vmSku.includes('OpenAI') || vmSku.includes('Standard')) {
    return checkAIQuota(token, subscriptionId, region, vmSku);
  }

  try {
    const result = await armRequest('GET',
      `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${region}/usages?api-version=2023-09-01`,
      token);

    const usages = result.value || [];

    // Map VM SKU prefix to quota family name
    const skuLower = vmSku.toLowerCase();
    let familyFilter = '';
    if (skuLower.includes('nc')) familyFilter = 'NC';
    else if (skuLower.includes('nd')) familyFilter = 'ND';
    else if (skuLower.includes('nv')) familyFilter = 'NV';
    else if (skuLower.includes('np')) familyFilter = 'NP';

    // Find matching quota entries
    const matches = usages.filter(u => {
      const name = (u.name?.localizedValue || u.name?.value || '').toLowerCase();
      return familyFilter && name.includes(familyFilter.toLowerCase());
    });

    if (matches.length === 0) {
      // Also check total regional vCPU quota
      const totalQuota = usages.find(u =>
        (u.name?.value || '').toLowerCase() === 'cores' ||
        (u.name?.localizedValue || '').toLowerCase().includes('total regional')
      );

      if (totalQuota) {
        const usage = totalQuota.currentValue || 0;
        const limit = totalQuota.limit || 0;
        return {
          withinQuota: limit > usage,
          usage, limit,
          quotaName: totalQuota.name?.localizedValue || 'Total Regional vCPUs',
          reason: limit > usage
            ? `Regional vCPU quota: ${usage}/${limit} used`
            : `Regional vCPU quota exhausted: ${usage}/${limit}. Request increase before retrying.`,
        };
      }
      return { withinQuota: true, reason: `No specific quota found for ${vmSku} family. Proceeding.`, warning: true };
    }

    // Report the most relevant match
    const best = matches[0];
    const usage = best.currentValue || 0;
    const limit = best.limit || 0;

    return {
      withinQuota: limit > usage,
      usage, limit,
      quotaName: best.name?.localizedValue || best.name?.value,
      reason: limit > usage
        ? `${best.name?.localizedValue}: ${usage}/${limit} vCPUs used`
        : `${best.name?.localizedValue}: quota full (${usage}/${limit}). Request increase at https://aka.ms/ProdportalCR`,
    };
  } catch (e) {
    return { withinQuota: true, reason: `Quota check failed: ${e.message}. Proceeding.`, warning: true };
  }
}

/**
 * Check AI/Cognitive Services quota for model deployments.
 */
async function checkAIQuota(token, subscriptionId, region, modelInfo) {
  try {
    // List Cognitive Services accounts in the subscription to find the right one
    const accounts = await armRequest('GET',
      `/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`,
      token);

    const aiAccounts = (accounts.value || []).filter(a =>
      a.location?.toLowerCase() === region?.toLowerCase() &&
      (a.kind === 'OpenAI' || a.kind === 'AIServices')
    );

    if (aiAccounts.length === 0) {
      return { withinQuota: true, reason: `No OpenAI/AI accounts in ${region}. Quota check skipped.`, warning: true };
    }

    // Check deployments on the first matching account
    const account = aiAccounts[0];
    const accountName = account.name;
    const rg = account.id.split('/resourceGroups/')[1]?.split('/')[0];

    const deployments = await armRequest('GET',
      `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${accountName}/deployments?api-version=2024-10-01`,
      token);

    const totalCapacity = (deployments.value || []).reduce((sum, d) => sum + (d.sku?.capacity || 0), 0);

    return {
      withinQuota: true,
      usage: totalCapacity,
      quotaName: `${accountName} total TPM`,
      reason: `AI account ${accountName}: ${totalCapacity} TPM deployed. Check model-specific quotas in Azure Portal.`,
      warning: true,
    };
  } catch (e) {
    return { withinQuota: true, reason: `AI quota check failed: ${e.message}. Proceeding.`, warning: true };
  }
}

/**
 * Full pre-flight check before retrying a deployment.
 * Returns { canRetry, checks[] }
 */
async function preFlightCheck(token, subscriptionId, region, vmSku) {
  const checks = [];

  // 1. SKU availability
  const skuCheck = await checkSkuAvailability(token, subscriptionId, region, vmSku);
  checks.push({ name: 'SKU Availability', ...skuCheck });

  // 2. Quota usage
  const quotaCheck = await checkComputeQuota(token, subscriptionId, region, vmSku);
  checks.push({ name: 'Quota', ...quotaCheck });

  // Can retry if SKU is available (or unknown) and quota allows it
  const canRetry = (skuCheck.available !== false) && (quotaCheck.withinQuota !== false);

  return { canRetry, checks };
}

module.exports = { preFlightCheck, checkSkuAvailability, checkComputeQuota };
