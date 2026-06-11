const state = {
  connected: false,
  senders: [],
  selected: new Set(),
  previewTotal: 0,
};

const $ = (id) => document.getElementById(id);

const els = {
  alert: $('alert'),
  loading: $('loading'),
  loginPanel: $('loginPanel'),
  appPanel: $('appPanel'),
  loginForm: $('loginForm'),
  emailInput: $('emailInput'),
  passwordInput: $('passwordInput'),
  disconnectBtn: $('disconnectBtn'),
  connectedEmail: $('connectedEmail'),
  limitSelect: $('limitSelect'),
  includeUnread: $('includeUnread'),
  skipFlagged: $('skipFlagged'),
  skipAttachments: $('skipAttachments'),
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
};

function setLoading(value) {
  els.loading.classList.toggle('hidden', !value);
}

function showError(message) {
  els.alert.textContent = message;
  els.alert.classList.remove('hidden');
}

function clearError() {
  els.alert.textContent = '';
  els.alert.classList.add('hidden');
}

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

function renderConnection(email) {
  state.connected = Boolean(email);
  els.loginPanel.classList.toggle('hidden', state.connected);
  els.appPanel.classList.toggle('hidden', !state.connected);
  els.disconnectBtn.classList.toggle('hidden', !state.connected);
  els.connectedEmail.textContent = email || '';
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function visibleSenders() {
  const q = els.senderSearch.value.trim().toLowerCase();
  if (!q) return state.senders;
  return state.senders.filter((s) =>
    `${s.fromName || ''} ${s.fromEmail || ''}`.toLowerCase().includes(q)
  );
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

  els.sendersTable.innerHTML = header + body;
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
  els.previewBtn.disabled = selectedSenders.length === 0;
}

async function init() {
  try {
    const status = await api('/status');
    renderConnection(status.connected ? status.email : null);
  } catch (_) {}
}

els.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  setLoading(true);
  try {
    const data = await api('/connect', {
      method: 'POST',
      body: JSON.stringify({ email: els.emailInput.value, appPassword: els.passwordInput.value }),
    });
    els.passwordInput.value = '';
    renderConnection(data.email);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

els.disconnectBtn.addEventListener('click', async () => {
  clearError();
  setLoading(true);
  try {
    await api('/disconnect', { method: 'POST', body: '{}' });
    state.senders = [];
    state.selected.clear();
    renderConnection(null);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

els.scanBtn.addEventListener('click', async () => {
  clearError();
  setLoading(true);
  try {
    const data = await api('/scan', {
      method: 'POST',
      body: JSON.stringify({ limit: Number(els.limitSelect.value) }),
    });
    state.senders = data.senders || [];
    state.selected.clear();
    renderSenders();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

els.senderSearch.addEventListener('input', renderSenders);

els.previewBtn.addEventListener('click', async () => {
  clearError();
  setLoading(true);
  els.resultPanel.classList.add('hidden');
  try {
    const data = await api('/preview', {
      method: 'POST',
      body: JSON.stringify({
        senders: Array.from(state.selected),
        limit: Number(els.limitSelect.value),
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
      <p>Messages to move to Trash: <strong>${data.total}</strong></p>
      <p>Unread included: <strong>${data.unread}</strong></p>
      <p>Flagged included: <strong>${data.flagged}</strong></p>
      <p>Attachments included: <strong>${data.attachments}</strong></p>
      <p class="muted">Skipped unread: ${data.skipped.unread}, skipped flagged: ${data.skipped.flagged}, skipped attachments: ${data.skipped.attachments}</p>`;

    els.sampleList.innerHTML = (data.sample || []).map((m) =>
      `<li>${m.unread ? '<strong>[Unread]</strong>' : '[Read]'} ${m.flagged ? '<strong>[Flagged]</strong>' : ''} ${m.hasAttachments ? '<strong>[Attachment]</strong>' : ''} ${escapeHtml(m.subject)} — ${escapeHtml(m.fromEmail)}</li>`
    ).join('');

    els.previewPanel.classList.remove('hidden');
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

els.confirmInput.addEventListener('input', () => {
  els.trashBtn.disabled = els.confirmInput.value !== `DELETE ${state.previewTotal}` || state.previewTotal === 0;
});

els.trashBtn.addEventListener('click', async () => {
  clearError();
  setLoading(true);
  try {
    const data = await api('/trash', {
      method: 'POST',
      body: JSON.stringify({ confirmText: els.confirmInput.value }),
    });
    els.previewPanel.classList.add('hidden');
    els.resultPanel.innerHTML = `Cleanup complete. Moved <strong>${data.moved}</strong> messages to <strong>${escapeHtml(data.trashFolder || 'Trash')}</strong>.`;
    els.resultPanel.classList.remove('hidden');
    state.previewTotal = 0;
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

init();
