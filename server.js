'use strict';

require('dotenv').config?.();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MemoryStoreFactory = require('memorystore');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ImapFlow } = require('imapflow');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET;

if (isProduction && (!SESSION_SECRET || SESSION_SECRET.length < 24)) {
  console.error('SESSION_SECRET must be set to a long random value in production.');
  process.exit(1);
}

const MemoryStore = MemoryStoreFactory(session);

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", 'data:'],
        "connect-src": ["'self'"],
      },
    },
  })
);

app.use(express.json({ limit: '300kb' }));

app.use(
  session({
    name: 'inbox_sweeper_sid',
    secret: SESSION_SECRET || 'development-secret-change-me-please',
    store: new MemoryStore({ checkPeriod: 30 * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 45 * 60 * 1000,
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/inbox-sweeper/api', apiLimiter);

function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  const host = req.get('host');
  if (!origin) return next();
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  } catch (_) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  next();
}

app.use('/inbox-sweeper/api', sameOriginGuard);


function cleanEnv(name) {
  return String(process.env[name] || '').trim();
}

function looksPlaceholder(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  return v.includes('your-') || v.includes('change-this') || v.includes('placeholder') || v === 'client-id' || v === 'client-secret';
}

function providerOAuthConfig(provider) {
  if (provider === 'gmail') {
    const clientId = cleanEnv('GOOGLE_CLIENT_ID');
    const clientSecret = cleanEnv('GOOGLE_CLIENT_SECRET');
    const configured = !looksPlaceholder(clientId) && !looksPlaceholder(clientSecret);
    return {
      configured,
      clientIdPresent: Boolean(clientId),
      clientSecretPresent: Boolean(clientSecret),
      redirectUriEnv: cleanEnv('GOOGLE_REDIRECT_URI'),
    };
  }
  if (provider === 'microsoft') {
    const clientId = cleanEnv('MICROSOFT_CLIENT_ID');
    const clientSecret = cleanEnv('MICROSOFT_CLIENT_SECRET');
    const tenant = cleanEnv('MICROSOFT_TENANT') || 'common';
    const configured = !looksPlaceholder(clientId) && !looksPlaceholder(clientSecret);
    return {
      configured,
      clientIdPresent: Boolean(clientId),
      clientSecretPresent: Boolean(clientSecret),
      tenant,
      redirectUriEnv: cleanEnv('MICROSOFT_REDIRECT_URI'),
    };
  }
  return { configured: false };
}

function requireOAuthConfigured(provider, req, res) {
  const cfg = providerOAuthConfig(provider);
  if (!cfg.configured) {
    const label = provider === 'gmail' ? 'Gmail' : 'Microsoft';
    const vars = provider === 'gmail'
      ? 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'
      : 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET';
    const redirect = redirectUri(req, provider);
    res.status(500).send(`${label} OAuth is not configured correctly. Set real values for ${vars}. Current redirect URI: ${redirect}`);
    return false;
  }
  return true;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function clampLimit(value) {
  return Math.max(1, Math.min(Number(value || 1000), 10000));
}

function randomState() {
  return crypto.randomBytes(24).toString('hex');
}

function baseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function redirectUri(req, provider) {
  if (provider === 'gmail' && process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  if (provider === 'microsoft' && process.env.MICROSOFT_REDIRECT_URI) return process.env.MICROSOFT_REDIRECT_URI;
  return `${baseUrl(req)}/inbox-sweeper/api/${provider}/callback`;
}

function requireAccount(provider) {
  return (req, res, next) => {
    if (!req.session.accounts?.[provider]) return res.status(401).json({ error: `${provider} account is not connected.` });
    next();
  };
}

function parseEmailAddress(value) {
  const raw = String(value || '').trim();
  const angle = raw.match(/<([^>]+)>/);
  const email = normalizeEmail(angle ? angle[1] : raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]);
  const name = raw.replace(/<[^>]+>/, '').replace(/^"|"$/g, '').trim();
  return { email, name };
}

function ensureSessionCollections(req) {
  req.session.accounts ||= {};
  req.session.scanCache ||= {};
  req.session.preview ||= null;
}

function safeIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function groupMessagesBySender(messages) {
  const map = new Map();
  for (const msg of messages) {
    const fromEmail = normalizeEmail(msg.fromEmail);
    if (!fromEmail) continue;
    const item = map.get(fromEmail) || {
      fromEmail,
      fromName: msg.fromName || '',
      totalCount: 0,
      unreadCount: 0,
      flaggedCount: 0,
      attachmentCount: 0,
      latestDate: null,
      sampleSubjects: [],
    };
    if (!item.fromName && msg.fromName) item.fromName = msg.fromName;
    item.totalCount += 1;
    if (msg.unread) item.unreadCount += 1;
    if (msg.flagged) item.flaggedCount += 1;
    if (msg.hasAttachments) item.attachmentCount += 1;
    if (msg.date && (!item.latestDate || msg.date > item.latestDate)) item.latestDate = msg.date;
    if (item.sampleSubjects.length < 3 && msg.subject) item.sampleSubjects.push(msg.subject);
    map.set(fromEmail, item);
  }
  return Array.from(map.values()).sort((a, b) => b.totalCount - a.totalCount);
}

function filterMessagesFromCache(req, provider, options) {
  const senders = new Set((options.senders || []).map(normalizeEmail).filter(Boolean));
  const cache = req.session.scanCache?.[provider];
  const messages = Array.isArray(cache?.messages) ? cache.messages : [];
  const includeUnread = options.includeUnread !== false;
  const skipFlagged = options.skipFlagged !== false;
  const skipAttachments = options.skipAttachments === true;
  const skipped = { unread: 0, flagged: 0, attachments: 0 };
  const matched = [];

  for (const msg of messages) {
    if (!senders.has(normalizeEmail(msg.fromEmail))) continue;
    if (!includeUnread && msg.unread) { skipped.unread += 1; continue; }
    if (skipFlagged && msg.flagged) { skipped.flagged += 1; continue; }
    if (skipAttachments && msg.hasAttachments) { skipped.attachments += 1; continue; }
    matched.push(msg);
  }

  matched.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { messages: matched, skipped };
}

// ---------------- Yahoo IMAP ----------------
function createYahooClient(credentials) {
  return new ImapFlow({
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: { user: credentials.email, pass: credentials.appPassword },
    logger: false,
    clientInfo: { name: 'Inbox Sweeper', version: '2.0.0' },
  });
}

async function withYahooClient(credentials, callback) {
  const client = createYahooClient(credentials);
  try {
    await client.connect();
    return await callback(client);
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

function hasAttachment(node) {
  if (!node) return false;
  const disposition = String(node.disposition || '').toLowerCase();
  const filename = node.parameters?.name || node.dispositionParameters?.filename;
  if (disposition === 'attachment' || filename) return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachment);
  return false;
}

async function scanYahooInbox(credentials, options = {}) {
  const limit = clampLimit(options.limit);
  const messages = [];
  return withYahooClient(credentials, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = await client.mailboxOpen('INBOX');
      if (!mailbox.exists) return { messages, senders: [] };
      const startSeq = Math.max(1, mailbox.exists - limit + 1);
      const range = `${startSeq}:*`;
      for await (const message of client.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true })) {
        const from = message.envelope?.from?.[0];
        const fromEmail = normalizeEmail(from?.address);
        if (!fromEmail) continue;
        messages.push({
          id: String(message.uid),
          provider: 'yahoo',
          fromEmail,
          fromName: String(from?.name || '').trim(),
          subject: message.envelope?.subject || '(No subject)',
          date: safeIsoDate(message.envelope?.date),
          unread: !message.flags.has('\\Seen'),
          flagged: message.flags.has('\\Flagged'),
          hasAttachments: Boolean(message.bodyStructure && hasAttachment(message.bodyStructure)),
        });
      }
      return { messages, senders: groupMessagesBySender(messages) };
    } finally {
      lock.release();
    }
  });
}

async function findYahooTrashFolder(client) {
  const mailboxes = await client.list();
  const folders = Array.isArray(mailboxes) ? mailboxes : [];
  const bySpecialUse = folders.find((box) => box.flags && box.flags.has('\\Trash'));
  if (bySpecialUse) return bySpecialUse.path;
  const common = folders.find((box) => /^(trash|deleted items|deleted messages)$/i.test(box.path));
  if (common) return common.path;
  const contains = folders.find((box) => /(trash|deleted)/i.test(box.path));
  if (contains) return contains.path;
  throw new Error('Could not locate a Trash folder in this mailbox.');
}

async function moveYahooToTrash(credentials, ids) {
  const uniqueUids = Array.from(new Set((ids || []).map(Number).filter(Number.isSafeInteger)));
  if (uniqueUids.length === 0) return { moved: 0, trashFolder: null };
  return withYahooClient(credentials, async (client) => {
    const trashFolder = await findYahooTrashFolder(client);
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.mailboxOpen('INBOX');
      let moved = 0;
      for (let i = 0; i < uniqueUids.length; i += 100) {
        const batch = uniqueUids.slice(i, i + 100);
        await client.messageMove(batch, trashFolder, { uid: true });
        moved += batch.length;
      }
      return { moved, trashFolder };
    } finally {
      lock.release();
    }
  });
}

// ---------------- OAuth shared ----------------
async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Token request failed: ${res.status}`);
  return json;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error?.message || json.error_description || json.error || `Request failed: ${res.status}`);
  return json;
}

async function refreshGmailIfNeeded(req) {
  const acct = req.session.accounts?.gmail;
  if (!acct) throw new Error('Gmail account is not connected.');
  if (acct.accessToken && acct.expiresAt && Date.now() < acct.expiresAt - 60_000) return acct.accessToken;
  if (!acct.refreshToken) throw new Error('Gmail session expired. Please reconnect Gmail.');
  const token = await postForm('https://oauth2.googleapis.com/token', {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: acct.refreshToken,
    grant_type: 'refresh_token',
  });
  acct.accessToken = token.access_token;
  acct.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  req.session.accounts.gmail = acct;
  return acct.accessToken;
}

async function refreshMicrosoftIfNeeded(req) {
  const acct = req.session.accounts?.microsoft;
  if (!acct) throw new Error('Microsoft account is not connected.');
  if (acct.accessToken && acct.expiresAt && Date.now() < acct.expiresAt - 60_000) return acct.accessToken;
  if (!acct.refreshToken) throw new Error('Microsoft session expired. Please reconnect Microsoft.');
  const tenant = process.env.MICROSOFT_TENANT || 'common';
  const token = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: acct.refreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access User.Read Mail.ReadWrite',
  });
  acct.accessToken = token.access_token;
  acct.refreshToken = token.refresh_token || acct.refreshToken;
  acct.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  req.session.accounts.microsoft = acct;
  return acct.accessToken;
}

// ---------------- Gmail ----------------
function gmailHeadersToObject(headers = []) {
  const out = {};
  for (const h of headers) out[String(h.name || '').toLowerCase()] = h.value || '';
  return out;
}

async function scanGmailInbox(req, options = {}) {
  const limit = clampLimit(options.limit);
  const token = await refreshGmailIfNeeded(req);
  const ids = [];
  let pageToken = '';
  while (ids.length < limit) {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('maxResults', String(Math.min(500, limit - ids.length)));
    url.searchParams.set('q', 'in:inbox');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    ids.push(...(data.messages || []).map((m) => m.id));
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  const messages = [];
  const concurrency = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
        detailUrl.searchParams.set('format', 'metadata');
        detailUrl.searchParams.append('metadataHeaders', 'From');
        detailUrl.searchParams.append('metadataHeaders', 'Subject');
        detailUrl.searchParams.append('metadataHeaders', 'Date');
        const msg = await fetchJson(detailUrl.toString(), { headers: { Authorization: `Bearer ${token}` } });
        const headers = gmailHeadersToObject(msg.payload?.headers || []);
        const parsed = parseEmailAddress(headers.from);
        if (!parsed.email) continue;
        messages.push({
          id,
          provider: 'gmail',
          fromEmail: parsed.email,
          fromName: parsed.name,
          subject: headers.subject || '(No subject)',
          date: safeIsoDate(headers.date),
          unread: Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD'),
          flagged: Array.isArray(msg.labelIds) && msg.labelIds.includes('STARRED'),
          hasAttachments: false,
        });
      } catch (_) {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  return { messages, senders: groupMessagesBySender(messages), note: 'Gmail attachment detection is not included in this metadata-only prototype.' };
}

async function moveGmailToTrash(req, ids) {
  const token = await refreshGmailIfNeeded(req);
  const uniqueIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  let moved = 0;
  for (const id of uniqueIds) {
    await fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    moved += 1;
  }
  return { moved, trashFolder: 'Gmail Trash' };
}

// ---------------- Microsoft ----------------
async function scanMicrosoftInbox(req, options = {}) {
  const limit = clampLimit(options.limit);
  const token = await refreshMicrosoftIfNeeded(req);
  const messages = [];
  let url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$top', String(Math.min(100, limit)));
  url.searchParams.set('$select', 'id,from,subject,receivedDateTime,isRead,flag,hasAttachments');
  url.searchParams.set('$orderby', 'receivedDateTime desc');
  while (url && messages.length < limit) {
    const data = await fetchJson(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    for (const msg of data.value || []) {
      const email = normalizeEmail(msg.from?.emailAddress?.address);
      if (!email) continue;
      messages.push({
        id: msg.id,
        provider: 'microsoft',
        fromEmail: email,
        fromName: msg.from?.emailAddress?.name || '',
        subject: msg.subject || '(No subject)',
        date: msg.receivedDateTime || null,
        unread: msg.isRead === false,
        flagged: msg.flag?.flagStatus && msg.flag.flagStatus !== 'notFlagged',
        hasAttachments: Boolean(msg.hasAttachments),
      });
      if (messages.length >= limit) break;
    }
    url = data['@odata.nextLink'] && messages.length < limit ? new URL(data['@odata.nextLink']) : null;
  }
  return { messages, senders: groupMessagesBySender(messages) };
}

async function moveMicrosoftToTrash(req, ids) {
  const token = await refreshMicrosoftIfNeeded(req);
  const uniqueIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  let moved = 0;
  for (const id of uniqueIds) {
    await fetchJson(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId: 'deleteditems' }),
    });
    moved += 1;
  }
  return { moved, trashFolder: 'Deleted Items' };
}

// ---------------- Routes ----------------
app.get('/', (_req, res) => res.redirect('/inbox-sweeper/'));

app.get('/inbox-sweeper/api/health', (_req, res) => res.json({ ok: true, app: 'Inbox Sweeper JS' }));


app.get('/inbox-sweeper/api/config', (req, res) => {
  const gmail = providerOAuthConfig('gmail');
  const microsoft = providerOAuthConfig('microsoft');
  res.json({
    publicBaseUrl: baseUrl(req),
    gmail: {
      configured: gmail.configured,
      clientIdPresent: gmail.clientIdPresent,
      clientSecretPresent: gmail.clientSecretPresent,
      redirectUri: redirectUri(req, 'gmail'),
    },
    microsoft: {
      configured: microsoft.configured,
      clientIdPresent: microsoft.clientIdPresent,
      clientSecretPresent: microsoft.clientSecretPresent,
      tenant: microsoft.tenant,
      redirectUri: redirectUri(req, 'microsoft'),
    },
  });
});

app.get('/inbox-sweeper/api/status', (req, res) => {
  ensureSessionCollections(req);
  const accounts = {};
  for (const provider of ['yahoo', 'gmail', 'microsoft']) {
    accounts[provider] = {
      connected: Boolean(req.session.accounts[provider]),
      email: req.session.accounts[provider]?.email || null,
    };
  }
  res.json({ accounts });
});

app.post('/inbox-sweeper/api/yahoo/connect', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const email = normalizeEmail(req.body.email);
    const appPassword = String(req.body.appPassword || '').trim();
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid Yahoo email address.' });
    if (!appPassword || appPassword.length < 8) return res.status(400).json({ error: 'Enter a valid Yahoo app password.' });
    const credentials = { email, appPassword };
    await withYahooClient(credentials, async () => true);
    req.session.accounts.yahoo = credentials;
    req.session.scanCache.yahoo = null;
    req.session.preview = null;
    res.json({ ok: true, email });
  } catch (_) {
    res.status(400).json({ error: 'Yahoo login failed. Confirm the email and app password.' });
  }
});

app.get('/inbox-sweeper/api/gmail/auth', (req, res) => {
  if (!requireOAuthConfigured('gmail', req, res)) return;
  ensureSessionCollections(req);
  const state = randomState();
  req.session.oauthState = { provider: 'gmail', state, createdAt: Date.now() };
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req, 'gmail'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email https://www.googleapis.com/auth/gmail.modify');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/inbox-sweeper/api/gmail/callback', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const saved = req.session.oauthState;
    if (!saved || saved.provider !== 'gmail' || saved.state !== req.query.state) throw new Error('OAuth state mismatch.');
    const token = await postForm('https://oauth2.googleapis.com/token', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code: req.query.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(req, 'gmail'),
    });
    const profile = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${token.access_token}` } });
    req.session.accounts.gmail = {
      email: profile.emailAddress || 'Gmail account',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    };
    req.session.scanCache.gmail = null;
    req.session.oauthState = null;
    res.redirect('/inbox-sweeper/?connected=gmail');
  } catch (error) {
    res.redirect(`/inbox-sweeper/?error=${encodeURIComponent('Gmail connection failed: ' + error.message)}`);
  }
});

app.get('/inbox-sweeper/api/microsoft/auth', (req, res) => {
  if (!requireOAuthConfigured('microsoft', req, res)) return;
  ensureSessionCollections(req);
  const tenant = process.env.MICROSOFT_TENANT || 'common';
  const state = randomState();
  req.session.oauthState = { provider: 'microsoft', state, createdAt: Date.now() };
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', process.env.MICROSOFT_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(req, 'microsoft'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'offline_access User.Read Mail.ReadWrite');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/inbox-sweeper/api/microsoft/callback', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const saved = req.session.oauthState;
    if (!saved || saved.provider !== 'microsoft' || saved.state !== req.query.state) throw new Error('OAuth state mismatch.');
    const tenant = process.env.MICROSOFT_TENANT || 'common';
    const token = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code: req.query.code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(req, 'microsoft'),
      scope: 'offline_access User.Read Mail.ReadWrite',
    });
    const me = await fetchJson('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    req.session.accounts.microsoft = {
      email: me.mail || me.userPrincipalName || 'Microsoft account',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    };
    req.session.scanCache.microsoft = null;
    req.session.oauthState = null;
    res.redirect('/inbox-sweeper/?connected=microsoft');
  } catch (error) {
    res.redirect(`/inbox-sweeper/?error=${encodeURIComponent('Microsoft connection failed: ' + error.message)}`);
  }
});

app.post('/inbox-sweeper/api/:provider/disconnect', (req, res) => {
  ensureSessionCollections(req);
  const provider = req.params.provider;
  if (!['yahoo', 'gmail', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Unknown provider.' });
  delete req.session.accounts[provider];
  delete req.session.scanCache[provider];
  if (req.session.preview?.provider === provider) req.session.preview = null;
  res.json({ ok: true });
});

app.post('/inbox-sweeper/api/:provider/scan', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const provider = req.params.provider;
    if (!['yahoo', 'gmail', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Unknown provider.' });
    if (!req.session.accounts[provider]) return res.status(401).json({ error: `${provider} account is not connected.` });

    let result;
    if (provider === 'yahoo') result = await scanYahooInbox(req.session.accounts.yahoo, { limit: req.body.limit });
    if (provider === 'gmail') result = await scanGmailInbox(req, { limit: req.body.limit });
    if (provider === 'microsoft') result = await scanMicrosoftInbox(req, { limit: req.body.limit });

    req.session.scanCache[provider] = { createdAt: Date.now(), messages: result.messages };
    req.session.preview = null;
    res.json({ senders: result.senders, note: result.note || null, scanned: result.messages.length });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Scan failed.' });
  }
});

app.post('/inbox-sweeper/api/:provider/preview', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const provider = req.params.provider;
    const senders = Array.isArray(req.body.senders) ? req.body.senders : [];
    if (!['yahoo', 'gmail', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Unknown provider.' });
    if (!req.session.accounts?.[provider]) return res.status(401).json({ error: `${provider} account is not connected.` });
    if (senders.length === 0) return res.status(400).json({ error: 'Select at least one sender.' });
    if (senders.length > 100) return res.status(400).json({ error: 'Select 100 senders or fewer at one time.' });
    const cache = req.session.scanCache?.[provider];
    if (!cache || !Array.isArray(cache.messages)) return res.status(400).json({ error: 'Please scan this account before previewing cleanup.' });
    if (Date.now() - cache.createdAt > 30 * 60 * 1000) return res.status(400).json({ error: 'Scan expired. Please scan again.' });

    const { messages, skipped } = filterMessagesFromCache(req, provider, {
      senders,
      includeUnread: req.body.includeUnread,
      skipFlagged: req.body.skipFlagged,
      skipAttachments: req.body.skipAttachments,
    });

    req.session.preview = {
      provider,
      createdAt: Date.now(),
      ids: messages.map((m) => m.id),
      senders: senders.map(normalizeEmail),
    };

    res.json({
      total: messages.length,
      unread: messages.filter((m) => m.unread).length,
      flagged: messages.filter((m) => m.flagged).length,
      attachments: messages.filter((m) => m.hasAttachments).length,
      skipped,
      sample: messages.slice(0, 25),
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Preview failed.' });
  }
});

app.post('/inbox-sweeper/api/:provider/trash', async (req, res) => {
  try {
    ensureSessionCollections(req);
    const provider = req.params.provider;
    if (!['yahoo', 'gmail', 'microsoft'].includes(provider)) return res.status(400).json({ error: 'Unknown provider.' });
    if (!req.session.accounts?.[provider]) return res.status(401).json({ error: `${provider} account is not connected.` });
    const preview = req.session.preview;
    if (!preview || preview.provider !== provider || !Array.isArray(preview.ids) || preview.ids.length === 0) return res.status(400).json({ error: 'Run a preview before moving messages to Trash.' });
    if (Date.now() - preview.createdAt > 10 * 60 * 1000) {
      req.session.preview = null;
      return res.status(400).json({ error: 'Preview expired. Please run the preview again.' });
    }
    const expected = `DELETE ${preview.ids.length}`;
    if (req.body.confirmText !== expected) return res.status(400).json({ error: `Type ${expected} to confirm.` });

    let result;
    if (provider === 'yahoo') result = await moveYahooToTrash(req.session.accounts.yahoo, preview.ids);
    if (provider === 'gmail') result = await moveGmailToTrash(req, preview.ids);
    if (provider === 'microsoft') result = await moveMicrosoftToTrash(req, preview.ids);
    req.session.preview = null;
    req.session.scanCache[provider] = null;
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Cleanup failed.' });
  }
});

app.use('/inbox-sweeper', express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/inbox-sweeper/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((_req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => console.log(`Inbox Sweeper running at http://localhost:${PORT}/inbox-sweeper/`));
