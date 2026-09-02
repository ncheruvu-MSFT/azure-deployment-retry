/* ============================================================
   Azure Deployment Retry Platform — app.js
   Vanilla JS SPA: dashboard, form, detail modal, polling
   ============================================================ */

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------
  const API_BASE = '/api';
  const REFRESH_INTERVAL_MS = 30_000;

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  const dom = {
    clock:           $('#clock'),
    userInfo:        $('#userInfo'),
    logoutBtn:       $('#logoutBtn'),
    tabs:            $$('.tab-btn'),
    tabContents:     $$('.tab-content'),
    filterStatus:    $('#filterStatus'),
    autoRefresh:     $('#autoRefresh'),
    btnRefresh:      $('#btnRefresh'),
    btnRetryLoad:    $('#btnRetryLoad'),
    requestsBody:    $('#requestsBody'),
    loadingState:    $('#loadingState'),
    emptyState:      $('#emptyState'),
    errorState:      $('#errorState'),
    errorDetail:     $('#errorDetail'),
    form:            $('#newRequestForm'),
    btnUpload:       $('#btnUploadTemplate'),
    templateFile:    $('#templateFile'),
    uploadedName:    $('#uploadedFileName'),
    btnSubmit:       $('#btnSubmit'),
    modal:           $('#detailModal'),
    modalTitle:      $('#modalTitle'),
    modalBody:       $('#modalBody'),
    modalFooter:     $('#modalFooter'),
    modalClose:      $('#modalClose'),
    toastContainer:  $('#toastContainer'),
    // Import Failed tab
    importSubId:     $('#importSubId'),
    btnLoadRgs:      $('#btnLoadRgs'),
    rgSelectRow:     $('#rgSelectRow'),
    importRgSelect:  $('#importRgSelect'),
    btnLoadFailed:   $('#btnLoadFailed'),
    importLoading:   $('#importLoadingState'),
    importEmpty:     $('#importEmptyState'),
    importError:     $('#importErrorState'),
    importErrorDetail: $('#importErrorDetail'),
    failedTableWrap: $('#failedTableWrap'),
    failedBody:      $('#failedBody'),
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let requests = [];
  let sortKey = 'createdAt';
  let sortDir = 'desc';
  let refreshTimer = null;

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function relativeTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function escHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  function isGuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  }

  function isValidRg(v) {
    return /^[-\w.()]+$/.test(v) && v.length <= 90;
  }

  function truncate(str, len = 32) {
    return str && str.length > len ? str.slice(0, len) + '…' : str || '—';
  }

  // ------------------------------------------------------------------
  // Clock
  // ------------------------------------------------------------------
  function tickClock() {
    dom.clock.textContent = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }
  setInterval(tickClock, 1000);
  tickClock();

  // ------------------------------------------------------------------
  // Toast Notifications
  // ------------------------------------------------------------------
  function toast(message, type = 'info', duration = 5000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${escHtml(message)}</span><button class="toast-close">✕</button>`;
    dom.toastContainer.appendChild(el);
    el.querySelector('.toast-close').addEventListener('click', () => el.remove());
    setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
  }

  // ------------------------------------------------------------------
  // API Client
  // ------------------------------------------------------------------
  async function apiFetch(path, opts = {}) {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const api = {
    listRequests:  ()        => apiFetch('/requests'),
    getRequest:    (id)      => apiFetch(`/requests/${id}`),
    createRequest: (data)    => apiFetch('/requests', { method: 'POST', body: JSON.stringify(data) }),
    cancelRequest: (id)      => apiFetch(`/requests/${id}/cancel`, { method: 'PUT' }),
    loadResourceGroups: (subId) => apiFetch(`/failed-deployments?subscriptionId=${encodeURIComponent(subId)}`),
    loadFailedDeployments: (subId, rg) => apiFetch(`/failed-deployments?subscriptionId=${encodeURIComponent(subId)}&resourceGroup=${encodeURIComponent(rg)}`),
    retryDeployment: (data)  => apiFetch('/retry-deployment', { method: 'POST', body: JSON.stringify(data) }),
  };

  // ------------------------------------------------------------------
  // Tab Navigation
  // ------------------------------------------------------------------
  dom.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      dom.tabs.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      dom.tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  function statusBadge(status) {
    const s = (status || 'pending').toLowerCase();
    const labels = { pending: 'Pending', retrying: 'Retrying', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled' };
    return `<span class="badge badge-${s}"><span class="dot"></span>${labels[s] || s}</span>`;
  }

  function renderTable() {
    const filter = dom.filterStatus.value;
    let data = filter ? requests.filter(r => r.status === filter) : [...requests];

    // Sort
    data.sort((a, b) => {
      let va = a[sortKey] ?? '';
      let vb = b[sortKey] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    // Header sort indicators
    $$('.data-table th[data-sort]').forEach(th => {
      const icon = th.querySelector('.sort-icon');
      if (th.dataset.sort === sortKey) {
        icon.classList.add('active');
        icon.textContent = sortDir === 'asc' ? '↑' : '↓';
      } else {
        icon.classList.remove('active');
        icon.textContent = '⇅';
      }
    });

    if (data.length === 0 && requests.length === 0) {
      dom.requestsBody.innerHTML = '';
      dom.emptyState.style.display = '';
      return;
    }
    dom.emptyState.style.display = 'none';

    if (data.length === 0) {
      dom.requestsBody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-secondary)">No requests match the selected filter.</td></tr>`;
      return;
    }

    dom.requestsBody.innerHTML = data.map(r => `
      <tr data-id="${escHtml(r.id)}">
        <td><code style="font-size:.82rem">${escHtml(truncate(r.id, 12))}</code></td>
        <td>${escHtml(r.vmSku ? 'GPU VM' : 'Resource')} <span class="badge badge-neutral" style="font-size:.72rem">${escHtml((r.templateType || 'arm').toUpperCase())}</span></td>
        <td>${escHtml(r.targetRegion || r.region || '—')}</td>
        <td><code>${escHtml(r.sku || r.vmSku || '—')}</code></td>
        <td>${statusBadge(r.status)}</td>
        <td style="text-align:center">${r.attemptCount ?? 0}</td>
        <td title="${escHtml(r.createdAt || '')}">${relativeTime(r.createdAt)}</td>
        <td title="${escHtml(r.lastAttemptAt || '')}">${relativeTime(r.lastAttemptAt)}</td>
        <td>
          ${['pending', 'retrying'].includes((r.status || '').toLowerCase())
            ? `<button class="btn btn-danger btn-sm cancel-btn" data-id="${escHtml(r.id)}">Cancel</button>`
            : '—'}
        </td>
      </tr>
    `).join('');

    // Row click → detail
    $$('#requestsBody tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('.cancel-btn')) return;
        openDetail(tr.dataset.id);
      });
    });

    // Cancel buttons
    $$('.cancel-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          await api.cancelRequest(id);
          toast('Request cancelled.', 'success');
          await loadRequests();
        } catch (err) {
          toast(`Cancel failed: ${err.message}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Cancel';
        }
      });
    });
  }

  function showDashboardState(state) {
    dom.loadingState.style.display = state === 'loading' ? '' : 'none';
    dom.emptyState.style.display = 'none';
    dom.errorState.style.display = state === 'error' ? '' : 'none';
    dom.requestsBody.innerHTML = '';
    if (state === 'loading') {
      $('#requestsTable').style.display = 'none';
    } else {
      $('#requestsTable').style.display = '';
    }
  }

  async function loadRequests() {
    showDashboardState('loading');
    try {
      const data = await api.listRequests();
      requests = Array.isArray(data) ? data : (data?.items || data?.value || []);
      showDashboardState('data');
      renderTable();
      prefillImportSubscription();
    } catch (err) {
      showDashboardState('error');
      dom.errorDetail.textContent = err.message;
    }
  }

  // Sorting
  $$('.data-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = 'asc';
      }
      renderTable();
    });
  });

  // Filter
  dom.filterStatus.addEventListener('change', renderTable);

  // Refresh
  dom.btnRefresh.addEventListener('click', loadRequests);
  dom.btnRetryLoad.addEventListener('click', loadRequests);

  // Auto-refresh
  function startAutoRefresh() {
    stopAutoRefresh();
    if (dom.autoRefresh.checked) {
      refreshTimer = setInterval(loadRequests, REFRESH_INTERVAL_MS);
    }
  }
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }
  dom.autoRefresh.addEventListener('change', startAutoRefresh);

  // ------------------------------------------------------------------
  // Detail Modal
  // ------------------------------------------------------------------
  function openModal() { dom.modal.classList.add('open'); }
  function closeModal() { dom.modal.classList.remove('open'); }

  dom.modalClose.addEventListener('click', closeModal);
  dom.modal.addEventListener('click', (e) => { if (e.target === dom.modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  async function openDetail(id) {
    openModal();
    dom.modalTitle.textContent = 'Loading…';
    dom.modalBody.innerHTML = '<div style="text-align:center;padding:40px"><div class="spinner"></div></div>';
    dom.modalFooter.innerHTML = '';

    try {
      const r = await api.getRequest(id);
      dom.modalTitle.textContent = r.deploymentName || `Request ${truncate(r.id, 12)}`;

      dom.modalBody.innerHTML = `
        <dl class="detail-grid">
          <dt>Request ID</dt><dd><code>${escHtml(r.id)}</code></dd>
          <dt>Deployment</dt><dd>${escHtml(r.deploymentName || '—')}</dd>
          <dt>Resource Group</dt><dd>${escHtml(r.resourceGroup || '—')}</dd>
          <dt>Subscription</dt><dd><code>${escHtml(r.subscriptionId || '—')}</code></dd>
          <dt>Region</dt><dd>${escHtml(r.targetRegion || r.region || '—')}</dd>
          <dt>SKU</dt><dd><code>${escHtml(r.sku || r.vmSku || '—')}</code></dd>
          <dt>Template Type</dt><dd>${escHtml(r.templateType || '—')}</dd>
          <dt>Priority</dt><dd>${escHtml(r.priority || 'normal')}</dd>
          ${r.notifyEmail ? `<dt>Email Notify</dt><dd>${escHtml(r.notifyEmail)}</dd>` : ''}
          ${r.notifyTeams ? `<dt>Teams Notify</dt><dd>Configured ✓</dd>` : ''}
          <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
          <dt>Attempts</dt><dd>${r.attemptCount ?? 0}</dd>
          <dt>Created</dt><dd>${fmtDate(r.createdAt)}</dd>
          <dt>Last Attempt</dt><dd>${fmtDate(r.lastAttemptAt)}</dd>
          ${r.notes ? `<dt>Notes</dt><dd>${escHtml(r.notes)}</dd>` : ''}
        </dl>

        ${renderTimeline(r.attempts || [])}

        <div class="expandable">
          <button class="expand-toggle" type="button">
            <span class="arrow">▶</span> Template Content
          </button>
          <div class="expand-body">${escHtml(r.templateContent || '(empty)')}</div>
        </div>

        ${r.templateParams ? `
        <div class="expandable">
          <button class="expand-toggle" type="button">
            <span class="arrow">▶</span> Template Parameters
          </button>
          <div class="expand-body">${escHtml(typeof r.templateParams === 'string' ? r.templateParams : JSON.stringify(r.templateParams, null, 2))}</div>
        </div>` : ''}

        ${r.lastError ? `
        <div class="expandable">
          <button class="expand-toggle" type="button">
            <span class="arrow">▶</span> Raw Error Details
          </button>
          <div class="expand-body">${escHtml(typeof r.lastError === 'string' ? r.lastError : JSON.stringify(r.lastError, null, 2))}</div>
        </div>` : ''}
      `;

      // Wire expand toggles
      $$('.expand-toggle', dom.modalBody).forEach(btn => {
        btn.addEventListener('click', () => btn.classList.toggle('open'));
      });

      // Footer actions
      const canCancel = ['pending', 'retrying'].includes((r.status || '').toLowerCase());
      const canResubmit = ['failed', 'cancelled'].includes((r.status || '').toLowerCase());

      dom.modalFooter.innerHTML = `
        ${canCancel ? '<button class="btn btn-danger" id="modalCancel">Cancel Request</button>' : ''}
        ${canResubmit ? '<button class="btn btn-primary" id="modalResubmit">Re-submit</button>' : ''}
        <button class="btn btn-ghost" id="modalDismiss">Close</button>
      `;

      $('#modalDismiss')?.addEventListener('click', closeModal);

      $('#modalCancel')?.addEventListener('click', async () => {
        try {
          await api.cancelRequest(r.id);
          toast('Request cancelled.', 'success');
          closeModal();
          await loadRequests();
        } catch (err) {
          toast(`Cancel failed: ${err.message}`, 'error');
        }
      });

      $('#modalResubmit')?.addEventListener('click', () => {
        closeModal();
        switchTab('new-request');
        populateFormFrom(r);
        toast('Form pre-filled from previous request. Review and submit.', 'info');
      });

    } catch (err) {
      dom.modalBody.innerHTML = `<div class="state-msg"><div class="icon">⚠️</div><p>Failed to load details</p><p class="sub">${escHtml(err.message)}</p></div>`;
    }
  }

  function renderTimeline(attempts) {
    if (!attempts || attempts.length === 0) return '<p style="color:var(--text-secondary);font-size:.88rem;margin-top:var(--space-l)">No attempt history available.</p>';

    const items = attempts.map((a, i) => {
      const isSuccess = a.result === 'succeeded' || a.result === 'success';
      const isError = a.result === 'failed' || a.result === 'error';
      const dotClass = isSuccess ? 'success' : isError ? 'error' : 'info';
      return `
        <div class="timeline-item">
          <div class="timeline-dot ${dotClass}">${i + 1}</div>
          <div class="timeline-body">
            <div class="ts">${fmtDate(a.timestamp || a.attemptedAt)}</div>
            <div class="msg">
              ${statusBadge(a.result || 'retrying')}
              ${a.errorMessage ? `<span style="margin-left:8px;font-size:.82rem;color:var(--text-secondary)">${escHtml(a.errorMessage)}</span>` : ''}
            </div>
          </div>
        </div>`;
    });

    return `<h3 style="font-size:.95rem;margin-bottom:var(--space-m)">Attempt History</h3><div class="timeline">${items.join('')}</div>`;
  }

  function switchTab(tabId) {
    dom.tabs.forEach(b => {
      const active = b.dataset.tab === tabId;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active);
    });
    dom.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabId}`));
  }

  function populateFormFrom(r) {
    $('#deploymentName').value = r.deploymentName || '';
    $('#resourceGroup').value = r.resourceGroup || '';
    $('#subscriptionId').value = r.subscriptionId || '';
    $('#targetRegion').value = r.targetRegion || '';
    $('#vmSku').value = r.sku || '';
    $('#priority').value = r.priority || 'normal';
    if (r.templateType) {
      const radio = $(`input[name="templateType"][value="${r.templateType}"]`);
      if (radio) radio.checked = true;
    }
    $('#templateContent').value = r.templateContent || '';
    $('#templateParams').value = typeof r.templateParams === 'string' ? r.templateParams : JSON.stringify(r.templateParams || {}, null, 2);
    $('#notes').value = r.notes || '';
    if (r.notifyEmail) $('#notifyEmail').value = r.notifyEmail;
    if (r.notifyTeams) $('#notifyTeams').value = r.notifyTeams;
  }

  // ------------------------------------------------------------------
  // New Request Form
  // ------------------------------------------------------------------
  // File upload
  dom.btnUpload.addEventListener('click', () => dom.templateFile.click());
  dom.templateFile.addEventListener('change', () => {
    const file = dom.templateFile.files[0];
    if (!file) return;
    dom.uploadedName.textContent = file.name;
    const reader = new FileReader();
    reader.onload = () => { $('#templateContent').value = reader.result; };
    reader.readAsText(file);
  });

  // Validation
  function validateField(id, testFn) {
    const el = $(`#${id}`);
    const group = el.closest('.form-group');
    const val = el.value.trim();
    const ok = testFn(val);
    group.classList.toggle('has-error', !ok);
    el.classList.toggle('invalid', !ok);
    el.classList.toggle('valid', ok && val.length > 0);
    return ok;
  }

  function validateForm() {
    let valid = true;
    valid = validateField('deploymentName', v => v.length > 0) && valid;
    valid = validateField('resourceGroup', v => v.length > 0 && isValidRg(v)) && valid;
    valid = validateField('subscriptionId', v => isGuid(v)) && valid;
    valid = validateField('targetRegion', v => v.length > 0) && valid;
    valid = validateField('vmSku', v => v.length > 0) && valid;
    valid = validateField('templateContent', v => v.length > 0) && valid;
    return valid;
  }

  // Template type help switching
  $$('input[name="templateType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const type = radio.value;
      $('#helpArm').style.display = type === 'arm' ? '' : 'none';
      $('#helpBicep').style.display = type === 'bicep' ? '' : 'none';
      $('#helpTerraform').style.display = type === 'terraform' ? '' : 'none';
      // Update placeholder
      const editor = $('#templateContent');
      if (type === 'arm') editor.placeholder = '{ "$schema": "https://schema.management.azure.com/..." }';
      else if (type === 'bicep') editor.placeholder = 'param location string = resourceGroup().location\nresource vm \'Microsoft.Compute/virtualMachines@2023-09-01\' = { ... }';
      else editor.placeholder = 'provider "azurerm" {\n  features {}\n}\n\nresource "azurerm_virtual_machine" "gpu" {\n  ...\n}';
    });
  });

  // Wire expand toggles in form
  $$('.form-section .expand-toggle').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('open'));
  });

  // Live validation on blur
  ['deploymentName', 'resourceGroup', 'subscriptionId', 'targetRegion', 'vmSku', 'templateContent'].forEach(id => {
    $(`#${id}`).addEventListener('blur', () => {
      const el = $(`#${id}`);
      if (el.value.trim().length > 0 || el.closest('.form-group').classList.contains('has-error')) {
        validateForm();
      }
    });
  });

  // Submit
  dom.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validateForm()) {
      toast('Please fix the highlighted fields.', 'error');
      return;
    }

    const payload = {
      deploymentName:  $('#deploymentName').value.trim(),
      resourceGroup:   $('#resourceGroup').value.trim(),
      subscriptionId:  $('#subscriptionId').value.trim(),
      targetRegion:    $('#targetRegion').value,
      sku:             $('#vmSku').value,
      templateType:    $('input[name="templateType"]:checked').value,
      templateContent: $('#templateContent').value,
      templateParams:  $('#templateParams').value.trim() || null,
      priority:        $('#priority').value,
      notes:           $('#notes').value.trim() || null,
      notifyEmail:     $('#notifyEmail')?.value?.trim() || '',
      notifyTeams:     $('#notifyTeams')?.value?.trim() || '',
    };

    // Try to parse templateParams as JSON if provided
    if (payload.templateParams) {
      try {
        payload.templateParams = JSON.parse(payload.templateParams);
      } catch {
        toast('Template Parameters is not valid JSON. It will be submitted as a string.', 'info');
      }
    }

    dom.btnSubmit.disabled = true;
    dom.btnSubmit.innerHTML = '<span class="spinner spinner-sm"></span> Submitting…';

    try {
      const result = await api.createRequest(payload);
      toast('Deployment request submitted successfully!', 'success');
      dom.form.reset();
      dom.uploadedName.textContent = '';
      $$('.form-group', dom.form).forEach(g => g.classList.remove('has-error'));
      $$('.form-control', dom.form).forEach(c => { c.classList.remove('invalid', 'valid'); });
      switchTab('dashboard');
      await loadRequests();
    } catch (err) {
      toast(`Submission failed: ${err.message}`, 'error');
    } finally {
      dom.btnSubmit.disabled = false;
      dom.btnSubmit.innerHTML = '🚀 Submit Request';
    }
  });

  // ------------------------------------------------------------------
  // Import Failed Deployments Tab
  // ------------------------------------------------------------------
  function showImportState(state) {
    dom.importLoading.style.display = state === 'loading' ? '' : 'none';
    dom.importEmpty.style.display = state === 'empty' ? '' : 'none';
    dom.importError.style.display = state === 'error' ? '' : 'none';
    dom.failedTableWrap.style.display = state === 'data' ? '' : 'none';
  }

  // Pre-fill subscription from any existing request (runs after initial load)
  function prefillImportSubscription() {
    if (!dom.importSubId.value && requests.length > 0 && requests[0].subscriptionId) {
      dom.importSubId.value = requests[0].subscriptionId;
    }
  }

  dom.btnLoadRgs.addEventListener('click', async () => {
    const subId = dom.importSubId.value.trim();
    if (!isGuid(subId)) {
      toast('Enter a valid Subscription ID (GUID format).', 'error');
      return;
    }

    dom.btnLoadRgs.disabled = true;
    dom.btnLoadRgs.innerHTML = '<span class="spinner spinner-sm"></span> Loading…';
    showImportState('loading');
    dom.rgSelectRow.style.display = 'none';

    try {
      const result = await api.loadResourceGroups(subId);
      const rgs = result.items || [];

      if (rgs.length === 0) {
        showImportState('empty');
        dom.importEmpty.querySelector('p').textContent = 'No resource groups found in this subscription.';
        return;
      }

      showImportState(null);
      dom.importRgSelect.innerHTML = '<option value="">Select a resource group…</option>' +
        rgs.map(rg => `<option value="${escHtml(rg.name)}">${escHtml(rg.name)} (${escHtml(rg.location)})</option>`).join('');
      dom.rgSelectRow.style.display = '';
    } catch (err) {
      showImportState('error');
      dom.importErrorDetail.textContent = err.message;
    } finally {
      dom.btnLoadRgs.disabled = false;
      dom.btnLoadRgs.innerHTML = '📂 Load Resource Groups';
    }
  });

  dom.btnLoadFailed.addEventListener('click', async () => {
    const subId = dom.importSubId.value.trim();
    const rg = dom.importRgSelect.value;

    if (!rg) {
      toast('Select a resource group first.', 'error');
      return;
    }

    dom.btnLoadFailed.disabled = true;
    dom.btnLoadFailed.innerHTML = '<span class="spinner spinner-sm"></span> Loading…';
    showImportState('loading');

    try {
      const result = await api.loadFailedDeployments(subId, rg);
      const items = result.items || [];

      if (items.length === 0) {
        showImportState('empty');
        return;
      }

      showImportState('data');
      dom.failedBody.innerHTML = items.map(dep => `
        <tr>
          <td><code style="font-size:.82rem">${escHtml(dep.name)}</code></td>
          <td title="${escHtml(dep.timestamp || '')}">${fmtDate(dep.timestamp)}</td>
          <td><span class="badge badge-failed">${escHtml(dep.errorCode || '—')}</span></td>
          <td title="${escHtml(dep.errorMessage || '')}">${escHtml(truncate(dep.errorMessage || '—', 60))}</td>
          <td><code style="font-size:.78rem">${escHtml(truncate(dep.correlationId || '—', 16))}</code></td>
          <td>
            <button class="btn btn-primary btn-sm retry-failed-btn"
              data-name="${escHtml(dep.name)}"
              data-sub="${escHtml(subId)}"
              data-rg="${escHtml(rg)}">🔄 Retry</button>
          </td>
        </tr>
      `).join('');

      // Wire retry buttons
      $$('.retry-failed-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const depName = btn.dataset.name;
          const depSub = btn.dataset.sub;
          const depRg = btn.dataset.rg;

          btn.disabled = true;
          btn.innerHTML = '<span class="spinner spinner-sm"></span>';

          try {
            await api.retryDeployment({
              subscriptionId: depSub,
              resourceGroup: depRg,
              deploymentName: depName,
              retryIntervalMinutes: 10,
            });
            toast(`Retry request created for "${depName}".`, 'success');
            switchTab('dashboard');
            await loadRequests();
          } catch (err) {
            toast(`Retry failed: ${err.message}`, 'error');
            btn.disabled = false;
            btn.innerHTML = '🔄 Retry';
          }
        });
      });
    } catch (err) {
      showImportState('error');
      dom.importErrorDetail.textContent = err.message;
    } finally {
      dom.btnLoadFailed.disabled = false;
      dom.btnLoadFailed.innerHTML = '🔍 Load Failed Deployments';
    }
  });

  // ------------------------------------------------------------------
  // Initialise
  // ------------------------------------------------------------------
  // Load user info from SWA auth
  async function loadUserInfo() {
    try {
      const resp = await fetch('/.auth/me');
      const data = await resp.json();
      const user = data?.clientPrincipal;
      if (user) {
        const name = user.userDetails || user.userId || 'User';
        dom.userInfo.textContent = name;
        dom.logoutBtn.style.display = '';
      }
    } catch(e) { /* not authenticated or auth disabled */ }
  }

  loadRequests();
  startAutoRefresh();
  loadUserInfo();

})();
