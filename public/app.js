const PROVIDERS = {
  yahoo: 'Yahoo',
  gmail: 'Gmail',
  microsoft: 'Microsoft / Outlook',
};

const state = {
  accounts: {},
  activeProvider: null,
  senders: [],
  selected: new Set(),
  previewTotal: 0,
};

const $ = (id) => document.getElementById(id);
const els = {
  alert: $('alert'),
  loading: $('loading'),
  refreshBtn: $('refreshBtn'),
  workspace: $('workspace'),
  providerSelect: $('providerSelect'),
  limitSelect: $('limitSelect'),
  includeUnread: $('includeUnread'),
  skipFlagged: $('skipFlagged'),
  skipAttachments: $('skipAttachments'),
  providerNote: $('providerNote'),
  scanBtn: $('scanBtn'),
  sendersPanel: $('sendersPanel'),
  senderSearch: $('senderSearch'),
  sendersTable: $('sendersTable'),
  selectionSummary: $('selectionSummary'),
  previewBtn: $('previewBtn'),
  previewPanel: $('previewPanel'),
  previewSummary: $('previewSummary'),
  sampleList: $('sampleList'),
  confirmExpected: $('confirmExpected'),
  confirmInput: $('confirmInput'),
  trashBtn: $('trashBtn'),
  resultPanel: $('resultPanel'),
  selectVisibleBtn: $('selectVisibleBtn'),
  clearSelectionBtn: $('clearSelectionBtn'),
  yahooForm: $('yahooForm'),
  yahooEmailInput: $('yahooEmailInput'),
  yahooPasswordInput: $('yahooPasswordInput'),
};

function setLoading(value) { els.loading.classList.toggle('hidden', !value); }
function clearError() { els.alert.textContent = ''; els.alert.classList.add('hidden'); }
function showError(message) { els.alert.textContent = message || 'Something went wrong.'; els.alert.classList.remove('hidden'); }

async function api(path, options = {}) {
  const res = await fetch(`/inbox-sweeper/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString();
}

function connectedProviders() {
  return Object.entries(state.accounts).filter(([, account]) => account.connected).map(([provider]) => provider);
}

function renderProviderCard(provider) {
  const account = state.accounts[provider] || { connected: false, email: null };
  const badge = $(`${provider}Badge`);
  const email = $(`${provider}Email`);
  const connect = $(`${provider}Connect`);
  const disconnect = $(`${provider}Disconnect`);
  const yahooForm = provider === 'yahoo' ? els.yahooForm : null;

  badge.textContent = account.connected ? 'Connected' : 'Not connected';
  badge.classList.toggle('connected-badge', account.connected);
  badge.classList.toggle('disconnected', !account.connected);
  email.textContent = account.connected ? account.email : '';
  if (connect) connect.classList.toggle('hidden', account.connected);
  if (disconnect) disconnect.classList.toggle('hidden', !account.connected);
  if (yahooForm) yahooForm.classList.toggle('hidden', account.connected);
}

function renderStatus() {
  for (const provider of Object.keys(PROVIDERS)) renderProviderCard(provider);
  const providers = connectedProviders();
  els.workspace.classList.toggle('hidden', providers.length === 0);

  const previous = state.activeProvider;
  els.providerSelect.innerHTML = providers.map((p) => `<option value="${p}">${PROVIDERS[p]} — ${escapeHtml(state.accounts[p].email)}</option>`).join('');
  if (providers.includes(previous)) state.activeProvider = previous;
  else state.activeProvider = providers[0] || null;
  if (state.activeProvider) els.providerSelect.value = state.activeProvider;
  renderSelectionSummary();
}

async function refreshStatus() {
  clearError();
  try {
    const data = await api('/status');
    state.accounts = data.accounts || {};
    renderStatus();
  } catch (err) {
    showError(err.message);
  }
}

function visibleSenders() {
  const q = els.senderSearch.value.trim().toLowerCase();
  if (!q) return state.senders;
  return state.senders.filter((s) => `${s.fromName || ''} ${s.fromEmail || ''}`.toLowerCase().includes(q));
}

function renderSenders() {
  const rows = visibleSenders();
  els.sendersPanel.classList.toggle('hidden', state.senders.length === 0);
  els.previewPanel.classList.add('hidden');
  els.resultPanel.classList.add('hidden');

  const header = `
    <div class="table-header">
      <div>Select</div><div>Sender</div><div>Total</div><div>Unread</div><div>Flagged</div><div>Attach.</div><div>Latest</div>
    </div>`;

  const body = rows.map((s) => {
    const checked = state.selected.has(s.fromEmail) ? 'checked' : '';
    return `
      <div class="table-row">
        <div><input type="checkbox" data-sender="${escapeHtml(s.fromEmail)}" ${checked}></div>
        <div><div class="sender-name">${escapeHtml(s.fromName || s.fromEmail)}</div><div class="sender-email">${escapeHtml(s.fromEmail)}</div></div>
        <div>${s.totalCount}</div>
        <div>${s.unreadCount}</div>
        <div>${s.flaggedCount}</div>
        <div>${s.attachmentCount}</div>
        <div>${formatDate(s.latestDate)}</div>
      </div>`;
  }).join('');

  els.sendersTable.innerHTML = header + (body || '<div class="empty-row">No matching senders.</div>');
  els.sendersTable.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.addEventListener('change', () => {
      const sender = box.dataset.sender;
      if (box.checked) state.selected.add(sender);
      else state.selected.delete(sender);
      renderSelectionSummary();
    });
  });
  renderSelectionSummary();
}

function renderSelectionSummary() {
  const selectedSenders = state.senders.filter((s) => state.selected.has(s.fromEmail));
  const count = selectedSenders.reduce((sum, s) => sum + s.totalCount, 0);
  els.selectionSummary.textContent = selectedSenders.length
    ? `Selected ${selectedSenders.length} sender(s), approximately ${count} matching scanned emails.`
    : 'No senders selected.';
  els.previewBtn.disabled = selectedSenders.length === 0 || !state.activeProvider;
}

function resetResults() {
  state.senders = [];
  state.selected.clear();
  state.previewTotal = 0;
  els.providerNote.textContent = '';
  els.sendersPanel.classList.add('hidden');
  els.previewPanel.classList.add('hidden');
  els.resultPanel.classList.add('hidden');
}

async function connectYahoo(e) {
  e.preventDefault();
  clearError();
  setLoading(true);
  try {
    await api('/yahoo/connect', {
      method: 'POST',
      body: JSON.stringify({ email: els.yahooEmailInput.value, appPassword: els.yahooPasswordInput.value }),
    });
    els.yahooPasswordInput.value = '';
    await refreshStatus();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function disconnectProvider(provider) {
  clearError();
  setLoading(true);
  try {
    await api(`/${provider}/disconnect`, { method: 'POST', body: '{}' });
    if (state.activeProvider === provider) resetResults();
    await refreshStatus();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function scanActiveProvider() {
  clearError();
  if (!state.activeProvider) return showError('Connect an account first.');
  setLoading(true);
  resetResults();
  try {
    const data = await api(`/${state.activeProvider}/scan`, {
      method: 'POST',
      body: JSON.stringify({ limit: Number(els.limitSelect.value) }),
    });
    state.senders = data.senders || [];
    els.providerNote.textContent = data.note || `Scanned ${data.scanned || 0} Inbox messages.`;
    renderSenders();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function previewCleanup() {
  clearError();
  if (!state.activeProvider) return showError('Connect an account first.');
  setLoading(true);
  els.resultPanel.classList.add('hidden');
  try {
    const data = await api(`/${state.activeProvider}/preview`, {
      method: 'POST',
      body: JSON.stringify({
        senders: Array.from(state.selected),
        includeUnread: els.includeUnread.checked,
        skipFlagged: els.skipFlagged.checked,
        skipAttachments: els.skipAttachments.checked,
      }),
    });

    state.previewTotal = data.total;
    const expected = `DELETE ${data.total}`;
    els.confirmExpected.textContent = expected;
    els.confirmInput.value = '';
    els.trashBtn.disabled = true;
    els.previewSummary.innerHTML = `
      <p>Provider: <strong>${PROVIDERS[state.activeProvider]}</strong></p>
      <p>Messages to move to Trash/Deleted Items: <strong>${data.total}</strong></p>
      <p>Unread included: <strong>${data.unread}</strong></p>
      <p>Starred/flagged included: <strong>${data.flagged}</strong></p>
      <p>Attachments included: <strong>${data.attachments}</strong></p>
      <p class="muted">Skipped unread: ${data.skipped.unread}, skipped flagged: ${data.skipped.flagged}, skipped attachments: ${data.skipped.attachments}</p>`;
    els.sampleList.innerHTML = (data.sample || []).map((m) =>
      `<li>${m.unread ? '<strong>[Unread]</strong>' : '[Read]'} ${m.flagged ? '<strong>[Flagged]</strong>' : ''} ${m.hasAttachments ? '<strong>[Attachment]</strong>' : ''} ${escapeHtml(m.subject)} — ${escapeHtml(m.fromEmail)}</li>`
    ).join('') || '<li>No messages matched the selected cleanup settings.</li>';
    els.previewPanel.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

async function moveToTrash() {
  clearError();
  if (!state.activeProvider) return showError('Connect an account first.');
  setLoading(true);
  try {
    const data = await api(`/${state.activeProvider}/trash`, {
      method: 'POST',
      body: JSON.stringify({ confirmText: els.confirmInput.value }),
    });
    els.previewPanel.classList.add('hidden');
    els.resultPanel.innerHTML = `Cleanup complete. Moved <strong>${data.moved}</strong> messages to <strong>${escapeHtml(data.trashFolder || 'Trash')}</strong>. Please rescan to refresh the sender list.`;
    els.resultPanel.classList.remove('hidden');
    state.senders = [];
    state.selected.clear();
    renderSenders();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

els.yahooForm.addEventListener('submit', connectYahoo);
els.refreshBtn.addEventListener('click', refreshStatus);
els.providerSelect.addEventListener('change', () => { state.activeProvider = els.providerSelect.value; resetResults(); });
els.scanBtn.addEventListener('click', scanActiveProvider);
els.senderSearch.addEventListener('input', renderSenders);
els.previewBtn.addEventListener('click', previewCleanup);
els.confirmInput.addEventListener('input', () => {
  els.trashBtn.disabled = els.confirmInput.value !== `DELETE ${state.previewTotal}` || state.previewTotal === 0;
});
els.trashBtn.addEventListener('click', moveToTrash);
els.selectVisibleBtn.addEventListener('click', () => { visibleSenders().forEach((s) => state.selected.add(s.fromEmail)); renderSenders(); });
els.clearSelectionBtn.addEventListener('click', () => { state.selected.clear(); renderSenders(); });

for (const provider of Object.keys(PROVIDERS)) {
  const btn = $(`${provider}Disconnect`);
  if (btn) btn.addEventListener('click', () => disconnectProvider(provider));
}

const params = new URLSearchParams(window.location.search);
if (params.get('error')) showError(params.get('error'));
if (params.get('connected')) window.history.replaceState({}, '', '/inbox-sweeper/');

refreshStatus();
