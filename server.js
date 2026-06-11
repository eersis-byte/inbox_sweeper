'use strict';

require('dotenv').config?.();

const path = require('path');
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

app.use(express.json({ limit: '250kb' }));

app.use(
  session({
    name: 'inbox_sweeper_sid',
    secret: SESSION_SECRET || 'development-secret-change-me',
    store: new MemoryStore({ checkPeriod: 30 * 60 * 1000 }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 30 * 60 * 1000,
    },
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/inbox-sweeper/api', apiLimiter);

function sameOriginGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  const origin = req.get('origin');
  const host = req.get('host');

  if (!origin) return next();

  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
  } catch (_) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }

  next();
}

app.use('/inbox-sweeper/api', sameOriginGuard);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function createYahooClient(credentials) {
  return new ImapFlow({
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: {
      user: credentials.email,
      pass: credentials.appPassword,
    },
    logger: false,
    clientInfo: {
      name: 'Inbox Sweeper',
      version: '1.0.0',
    },
  });
}

async function withYahooClient(credentials, callback) {
  const client = createYahooClient(credentials);
  try {
    await client.connect();
    return await callback(client);
  } finally {
    try {
      await client.logout();
    } catch (_) {}
  }
}

async function testYahooLogin(credentials) {
  await withYahooClient(credentials, async () => true);
  return true;
}

async function scanInbox(credentials, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 1000), 10000));
  const senderMap = new Map();

  return withYahooClient(credentials, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = await client.mailboxOpen('INBOX');
      if (!mailbox.exists) return [];

      const startSeq = Math.max(1, mailbox.exists - limit + 1);
      const range = `${startSeq}:*`;

      for await (const message of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
      })) {
        const from = message.envelope?.from?.[0];
        const fromEmail = normalizeEmail(from?.address);
        if (!fromEmail) continue;

        const fromName = String(from?.name || '').trim();
        const unread = !message.flags.has('\\Seen');
        const flagged = message.flags.has('\\Flagged');
        const date = message.envelope?.date ? new Date(message.envelope.date).toISOString() : null;
        const hasAttachments = Boolean(message.bodyStructure && hasAttachment(message.bodyStructure));

        const item = senderMap.get(fromEmail) || {
          fromEmail,
          fromName,
          totalCount: 0,
          unreadCount: 0,
          flaggedCount: 0,
          attachmentCount: 0,
          latestDate: null,
          sampleSubjects: [],
        };

        if (!item.fromName && fromName) item.fromName = fromName;
        item.totalCount += 1;
        if (unread) item.unreadCount += 1;
        if (flagged) item.flaggedCount += 1;
        if (hasAttachments) item.attachmentCount += 1;
        if (date && (!item.latestDate || date > item.latestDate)) item.latestDate = date;
        if (item.sampleSubjects.length < 3 && message.envelope?.subject) {
          item.sampleSubjects.push(message.envelope.subject);
        }

        senderMap.set(fromEmail, item);
      }

      return Array.from(senderMap.values()).sort((a, b) => b.totalCount - a.totalCount);
    } finally {
      lock.release();
    }
  });
}

function hasAttachment(node) {
  if (!node) return false;
  const disposition = String(node.disposition || '').toLowerCase();
  const filename = node.parameters?.name || node.dispositionParameters?.filename;
  if (disposition === 'attachment' || filename) return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachment);
  return false;
}

async function findMessagesBySenders(credentials, senders, options = {}) {
  const normalizedSenders = new Set((senders || []).map(normalizeEmail).filter(Boolean));
  const limit = Math.max(1, Math.min(Number(options.limit || 1000), 10000));
  const includeUnread = options.includeUnread !== false;
  const skipFlagged = options.skipFlagged !== false;
  const skipAttachments = options.skipAttachments === true;
  const matches = [];
  const skipped = { unread: 0, flagged: 0, attachments: 0 };

  if (normalizedSenders.size === 0) return { messages: [], skipped };

  return withYahooClient(credentials, async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = await client.mailboxOpen('INBOX');
      if (!mailbox.exists) return { messages: [], skipped };

      const startSeq = Math.max(1, mailbox.exists - limit + 1);
      const range = `${startSeq}:*`;

      for await (const message of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
      })) {
        const from = message.envelope?.from?.[0];
        const fromEmail = normalizeEmail(from?.address);
        if (!normalizedSenders.has(fromEmail)) continue;

        const unread = !message.flags.has('\\Seen');
        const flagged = message.flags.has('\\Flagged');
        const hasAttachments = Boolean(message.bodyStructure && hasAttachment(message.bodyStructure));

        if (!includeUnread && unread) {
          skipped.unread += 1;
          continue;
        }
        if (skipFlagged && flagged) {
          skipped.flagged += 1;
          continue;
        }
        if (skipAttachments && hasAttachments) {
          skipped.attachments += 1;
          continue;
        }

        matches.push({
          uid: message.uid,
          fromEmail,
          fromName: String(from?.name || '').trim(),
          subject: message.envelope?.subject || '(No subject)',
          date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null,
          unread,
          flagged,
          hasAttachments,
        });
      }

      matches.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return { messages: matches, skipped };
    } finally {
      lock.release();
    }
  });
}

async function findTrashFolder(client) {
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

async function moveToTrash(credentials, uids) {
  const uniqueUids = Array.from(new Set((uids || []).map(Number).filter(Number.isSafeInteger)));
  if (uniqueUids.length === 0) return { moved: 0, trashFolder: null };

  return withYahooClient(credentials, async (client) => {
    const trashFolder = await findTrashFolder(client);
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.mailboxOpen('INBOX');
      let moved = 0;
      const batchSize = 100;
      for (let i = 0; i < uniqueUids.length; i += batchSize) {
        const batch = uniqueUids.slice(i, i + batchSize);
        await client.messageMove(batch, trashFolder, { uid: true });
        moved += batch.length;
      }
      return { moved, trashFolder };
    } finally {
      lock.release();
    }
  });
}

function requireLogin(req, res, next) {
  if (!req.session.yahooCredentials) {
    return res.status(401).json({ error: 'Yahoo account is not connected.' });
  }
  next();
}

app.get('/', (_req, res) => res.redirect('/inbox-sweeper/'));

app.get('/inbox-sweeper/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Inbox Sweeper Yahoo JS' });
});

app.get('/inbox-sweeper/api/status', (req, res) => {
  res.json({
    connected: Boolean(req.session.yahooCredentials),
    email: req.session.yahooCredentials?.email || null,
  });
});

app.post('/inbox-sweeper/api/connect', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const appPassword = String(req.body.appPassword || '').trim();

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Enter a valid Yahoo email address.' });
    }
    if (!appPassword || appPassword.length < 8) {
      return res.status(400).json({ error: 'Enter a valid Yahoo app password.' });
    }

    const credentials = { email, appPassword };
    await testYahooLogin(credentials);

    req.session.yahooCredentials = credentials;
    req.session.preview = null;

    res.json({ ok: true, email });
  } catch (error) {
    res.status(400).json({ error: 'Yahoo login failed. Confirm the email and app password.' });
  }
});

app.post('/inbox-sweeper/api/disconnect', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.post('/inbox-sweeper/api/scan', requireLogin, async (req, res) => {
  try {
    const senders = await scanInbox(req.session.yahooCredentials, { limit: req.body.limit });
    res.json({ senders });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Scan failed.' });
  }
});

app.post('/inbox-sweeper/api/preview', requireLogin, async (req, res) => {
  try {
    const senders = Array.isArray(req.body.senders) ? req.body.senders : [];
    if (senders.length === 0) return res.status(400).json({ error: 'Select at least one sender.' });
    if (senders.length > 100) return res.status(400).json({ error: 'Select 100 senders or fewer at one time.' });

    const { messages, skipped } = await findMessagesBySenders(req.session.yahooCredentials, senders, {
      limit: req.body.limit,
      includeUnread: req.body.includeUnread,
      skipFlagged: req.body.skipFlagged,
      skipAttachments: req.body.skipAttachments,
    });

    const uids = messages.map((message) => message.uid);
    req.session.preview = {
      createdAt: Date.now(),
      uids,
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

app.post('/inbox-sweeper/api/trash', requireLogin, async (req, res) => {
  try {
    const preview = req.session.preview;
    if (!preview || !Array.isArray(preview.uids) || preview.uids.length === 0) {
      return res.status(400).json({ error: 'Run a preview before moving messages to Trash.' });
    }

    if (Date.now() - preview.createdAt > 10 * 60 * 1000) {
      req.session.preview = null;
      return res.status(400).json({ error: 'Preview expired. Please run the preview again.' });
    }

    const expected = `DELETE ${preview.uids.length}`;
    if (req.body.confirmText !== expected) {
      return res.status(400).json({ error: `Type ${expected} to confirm.` });
    }

    const result = await moveToTrash(req.session.yahooCredentials, preview.uids);
    req.session.preview = null;

    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Cleanup failed.' });
  }
});

app.use('/inbox-sweeper', express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/inbox-sweeper/*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((_req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`Inbox Sweeper running at http://localhost:${PORT}/inbox-sweeper/`);
});
