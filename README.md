# Inbox Sweeper - Yahoo Prototype

A simple JavaScript/Node website that connects to Yahoo Mail by IMAP app password, scans Inbox senders, previews selected sender messages, and moves them to Trash.

## Important

This cannot run as a browser-only static site because Yahoo IMAP requires a backend TCP/TLS connection. This project uses:

- Vanilla HTML/CSS/JavaScript frontend
- Node.js + Express backend
- Yahoo IMAP via `imapflow`
- Session-only Yahoo credentials
- Move-to-Trash only

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000/inbox-sweeper/
```

## Environment variables

```env
NODE_ENV=production
SESSION_SECRET=use-a-long-random-secret
PORT=3000
```

## Deploy without Railway

Recommended simple choices:

### Render

1. Push this folder to GitHub.
2. In Render, create a new Web Service from the repo.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET=your-long-random-secret`

### VPS / DigitalOcean / Hetzner / Lightsail

```bash
git clone YOUR_REPO_URL
cd inbox-sweeper-yahoo-js
npm install
NODE_ENV=production SESSION_SECRET="your-secret" PORT=3000 npm start
```

Use Nginx or Cloudflare Tunnel to point `emailgate.org/inbox-sweeper/` to this Node app.

## Yahoo app password

Users should use a Yahoo app password, not their regular Yahoo password.

## Safety defaults

- Scans Inbox only.
- Includes unread messages by default.
- Skips flagged messages by default.
- Moves messages to Trash only.
- Requires exact confirmation text before moving messages.
- Does not permanently delete emails.
- Credentials are stored only in the server session and cleared on disconnect/session expiration.

## Limitations

- Prototype uses in-memory sessions. If the server restarts, users are disconnected.
- For multiple server instances, use Redis-backed sessions.
- Large mailboxes can take time to scan.
- Yahoo folder naming can vary. The app attempts to detect the Trash folder by special-use flag, then common names.
