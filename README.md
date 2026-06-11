# Inbox Sweeper JS

A simple no-build JavaScript email cleanup app for:

- Yahoo Mail using IMAP + app password
- Gmail using OAuth + Gmail API
- Microsoft Outlook / Office 365 using OAuth + Microsoft Graph

The app scans recent Inbox messages, groups them by sender, lets the user select senders, previews matching messages, and moves confirmed messages to Trash / Deleted Items. It does **not** permanently delete mail.

## Important safety notes

- Messages are moved to Trash / Deleted Items only.
- The app works from the latest scanned Inbox messages only.
- Preview expires after 10 minutes.
- The scan cache expires after 30 minutes.
- Yahoo app passwords and OAuth tokens are stored only in the temporary server session.
- For production use, use HTTPS and a strong `SESSION_SECRET`.
- Gmail attachment detection is not included in this metadata-only prototype. Yahoo and Microsoft attachment detection are supported.

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
PORT=3000
SESSION_SECRET=use-a-long-random-secret-at-least-24-characters
PUBLIC_BASE_URL=https://yourdomain.com

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://yourdomain.com/inbox-sweeper/api/gmail/callback

MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT=common
MICROSOFT_REDIRECT_URI=https://yourdomain.com/inbox-sweeper/api/microsoft/callback
```

`PUBLIC_BASE_URL` should be your deployed origin, such as:

```text
https://emailgate.org
```

If you leave the redirect URI variables blank, the app automatically uses:

```text
PUBLIC_BASE_URL + /inbox-sweeper/api/gmail/callback
PUBLIC_BASE_URL + /inbox-sweeper/api/microsoft/callback
```

## Yahoo setup

Yahoo uses an app password. The user enters:

- Yahoo email address
- Yahoo app password

The app connects to:

```text
imap.mail.yahoo.com
Port 993
SSL/TLS
```

## Gmail setup

1. Go to Google Cloud Console.
2. Create or select a project.
3. Enable the Gmail API.
4. Configure the OAuth consent screen.
5. Create an OAuth client.
6. Add this authorized redirect URI:

```text
https://yourdomain.com/inbox-sweeper/api/gmail/callback
```

7. Add these environment variables:

```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
PUBLIC_BASE_URL=https://yourdomain.com
```

The app requests this Gmail scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

That scope allows read/write mail operations except immediate permanent deletion bypassing Trash. This prototype uses the Gmail `messages.trash` endpoint.

## Microsoft setup

1. Go to Microsoft Entra admin center / Azure Portal.
2. Create an App Registration.
3. Add a Web redirect URI:

```text
https://yourdomain.com/inbox-sweeper/api/microsoft/callback
```

4. Add delegated Microsoft Graph permissions:

```text
offline_access
User.Read
Mail.ReadWrite
```

5. Create a client secret.
6. Add these environment variables:

```env
MICROSOFT_CLIENT_ID=your-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret
MICROSOFT_TENANT=common
PUBLIC_BASE_URL=https://yourdomain.com
```

The app moves Microsoft messages to the well-known folder name:

```text
deleteditems
```

## Deploying without Railway

This app has no build step. It can be hosted anywhere that runs Node.js 20, such as:

- Render Web Service
- Fly.io
- DigitalOcean App Platform
- A VPS with Node + PM2
- AWS Lightsail

Typical settings:

```bash
Build command: npm install
Start command: npm start
```

## Routes

Frontend:

```text
/inbox-sweeper/
```

API health check:

```text
/inbox-sweeper/api/health
```

OAuth callback routes:

```text
/inbox-sweeper/api/gmail/callback
/inbox-sweeper/api/microsoft/callback
```

## Known limitations

- Inbox-only scanning in this version.
- Scans up to 10,000 recent Inbox messages.
- Gmail attachment detection is not included in this metadata-only prototype.
- OAuth credentials and Yahoo app passwords are in server memory session only; restarting the server disconnects accounts.
- Memory sessions are not suitable for multi-server scaling.

## Next suggested features

- Add folder selection.
- Add all-folder scan.
- Add progress updates for large scans.
- Add CSV cleanup report export.
- Add per-provider OAuth setup diagnostics.
- Add persistent encrypted token storage for personal/internal use.
