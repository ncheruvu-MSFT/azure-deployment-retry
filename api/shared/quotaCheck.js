// Quota pre-check for GPU VM deployments
// Checks SKU availability + vCPU quota for GPU families (NC, ND, NV, NP)
const { armRequest } = require('./armClient');

// GPU VM family mappings
const GPU_FAMILIES = {
  nc:  { prefix: 'nc',  quotaName: 'Standard NC Family vCPUs' },
  ncs: { prefix: 'ncs', quotaName: 'Standard NCSv3 Family vCPUs' },
  nds: { prefix: 'nds', quotaName: 'Standard NDSv2 Family vCPUs' },
  nd:  { prefix: 'nd',  quotaName: 'Standard ND Family vCPUs' },
  nv:  { prefix: 'nv',  quotaName: 'Standard NV Family vCPUs' },
  np:  { prefix: 'np',  quotaName: 'Standard NP Family vCPUs' },
};

function isGpuSku(vmSku) {
  if (!vmSku) return false;
  const lower = vmSku.toLowerCase();
  return lower.startsWith('standard_nc') || lower.startsWith('standard_nd') ||
         lower.startsWith('standard_nv') || lower.startsWith('standard_np');
}

function getGpuFamily(vmSku) {
  if (!vmSku) return null;
  const lower = vmSku.toLowerCase().replace('standard_', '');
  // Match most specific first: ncs, nds, then nc, nd, nv, np
  if (lower.startsWith('nc')) return 'nc';
  if (lower.startsWith('nd')) return 'nd';
  if (lower.startsWith('nv')) return 'nv';
  if (lower.startsWith('np')) return 'np';
  return null;
}

/**
 * Check if a GPU SKU is available in the target region (not restricted).
 */
async function checkSkuAvailability(token, subscriptionId, region, vmSku) {
  if (!isGpuSku(vmSku)) {
    return { available: true, reason: `${vmSku || 'Unknown'} is not a GPU SKU — skipping availability check` };
  }

  try {
    const result = await armRequest('GET',
      `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01&%24filter=location%20eq%20'${region}'`,
      token);

    const skus = result.value || [];
    const match = skus.find(s => s.name && s.name.toLowerCase() === vmSku.toLowerCase());

    if (!match) {
      return { available: false, reason: `GPU SKU ${vmSku} not found in ${region}. Try a different region or SKU.` };
    }

    // Check for location restrictions (NotAvailableForSubscription)
    const restrictions = match.restrictions || [];
    for (const r of restrictions) {
      if (r.type === 'Location') {
        const locs = (r.restrictionInfo?.locations || []).map(l => l.toLowerCase());
        if (locs.includes(region.toLowerCase())) {
          const reasonCode = r.reasonCode || 'Restricted';
          return {
            available: false,
            reason: `GPU SKU ${vmSku} is ${reasonCode} in ${region}. ` +
              (reasonCode === 'NotAvailableForSubscription'
                ? 'Request access at https://aka.ms/ProdportalCR'
                : 'Try a different region.'),
            reasonCode,
          };
        }
      }
    }

    // Check zone restrictions
    const zoneRestrictions = restrictions.filter(r => r.type === 'Zone');
    const zoneNote = zoneRestrictions.length > 0
      ? `(some zones restricted: ${zoneRestrictions.flatMap(r => r.restrictionInfo?.zones || []).join(', ')})`
      : '(all zones available)';

    return {
      available: true,
      reason: `GPU SKU ${vmSku} available in ${region} ${zoneNote}`,
      capabilities: {
        vCPUs: match.capabilities?.find(c => c.name === 'vCPUs')?.value,
        gpus: match.capabilities?.find(c => c.name === 'GPUs')?.value,
        memory: match.capabilities?.find(c => c.name === 'MemoryGB')?.value,
      },
    };
  } catch (e) {
    return { available: true, reason: `SKU check failed: ${(e.message || '').substring(0, 100)}. Proceeding.`, warning: true };
  }
}

/**
 * Check GPU vCPU quota usage in the target region.
 */
async function checkGpuQuota(token, subscriptionId, region, vmSku) {
  if (!isGpuSku(vmSku)) {
    return { withinQuota: true, reason: `${vmSku || 'Unknown'} is not a GPU SKU — skipping quota check` };
  }

  const family = getGpuFamily(vmSku);

  try {
    const result = await armRequest('GET',
      `/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${region}/usages?api-version=2023-09-01`,
      token);

    const usages = result.value || [];
    const checks = [];

    // 1. Check GPU family-specific quota
    const familyQuota = usages.find(u => {
      const name = (u.name?.localizedValue || u.name?.value || '').toLowerCase();
      return family && (
        name.includes(family.toLowerCase() + ' ') ||
        name.includes(family.toLowerCase() + 's') ||
        name.includes(family.toUpperCase())
      );
    });

    if (familyQuota) {
      const usage = familyQuota.currentValue || 0;
      const limit = familyQuota.limit || 0;
      checks.push({
        name: familyQuota.name?.localizedValue || `${family.toUpperCase()} Family`,
        usage, limit,
        available: limit - usage,
        sufficient: limit > usage,
      });
      if (limit <= usage) {
        return {
          withinQuota: false,
          usage, limit,
          quotaName: familyQuota.name?.localizedValue,
          reason: `${familyQuota.name?.localizedValue}: quota full (${usage}/${limit} vCPUs). ` +
            `Request increase at https://aka.ms/ProdportalCR before retrying.`,
          checks,
        };
      }
    }

    // 2. Check total regional vCPU quota
    const totalQuota = usages.find(u =>
      (u.name?.value || '').toLowerCase() === 'cores' ||
      (u.name?.localizedValue || '').toLowerCase().includes('total regional')
    );

    if (totalQuota) {
      const usage = totalQuota.currentValue || 0;
      const limit = totalQuota.limit || 0;
      checks.push({
        name: 'Total Regional vCPUs',
        usage, limit,
        available: limit - usage,
        sufficient: limit > usage,
      });
      if (limit <= usage) {
        return {
          withinQuota: false,
          usage, limit,
          quotaName: 'Total Regional vCPUs',
          reason: `Regional vCPU quota exhausted (${usage}/${limit}). Request increase before retrying.`,
          checks,
        };
      }
    }

    // Quota looks good
    const summary = checks.map(c => `${c.name}: ${c.usage}/${c.limit}`).join(', ');
    return {
      withinQuota: true,
      reason: `GPU quota available. ${summary}`,
      checks,
    };
  } catch (e) {
    return { withinQuota: true, reason: `Quota check failed: ${(e.message || '').substring(0, 100)}. Proceeding.`, warning: true };
  }
}

/**
 * Full pre-flight check for GPU VM deployment.
 * Returns { canRetry, checks[], summary }
 */
async function preFlightCheck(token, subscriptionId, region, vmSku) {
  const checks = [];

  // Only GPU SKUs are supported for retry
  if (!isGpuSku(vmSku)) {
    return {
      canRetry: false,
      summary: `Retry blocked: ${vmSku || 'Unknown'} is not a GPU SKU. Only GPU VMs (NC/ND/NV/NP families) are supported.`,
      checks: [{ check: 'GPU SKU Required', available: false, reason: `${vmSku || 'Unknown'} is not a GPU SKU (Standard_NC*, Standard_ND*, Standard_NV*, Standard_NP*)` }],
    };
  }

  // 1. GPU SKU availability in region
  const skuCheck = await checkSkuAvailability(token, subscriptionId, region, vmSku);
  checks.push({ check: 'SKU Availability', ...skuCheck });

  // 2. GPU vCPU quota
  const quotaCheck = await checkGpuQuota(token, subscriptionId, region, vmSku);
  checks.push({ check: 'GPU Quota', ...quotaCheck });

  const canRetry = (skuCheck.available !== false) && (quotaCheck.withinQuota !== false);
  const blockers = checks.filter(c => c.available === false || c.withinQuota === false);

  return {
    canRetry,
    summary: canRetry
      ? `Pre-flight passed: ${vmSku} ready in ${region}`
      : `Blocked: ${blockers.map(b => b.reason).join('; ')}`,
    checks,
  };
}

module.exports = { preFlightCheck, checkSkuAvailability, checkGpuQuota, isGpuSku };
