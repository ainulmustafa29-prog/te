# TempMal.com — Free Temporary Email

Temporary Email That Shields Your Real Mailbox.

TempMal.com is a fully functional temporary email website. It creates real, disposable
mailboxes through the official [Mail.tm API](https://api.mail.tm) and displays real
incoming messages. There is no fake data, no mockups, and no simulated functionality.

## Features

- Real Mail.tm account creation, authentication, and inbox retrieval
- Live inbox with automatic updates (conservative polling; Mail.tm exposes no reliable SSE endpoint)
- One-click copy of your temporary address
- Read/unread states, message reader with attachments
- Sanitized HTML rendering for received emails
- Light/dark/system theme
- Session restoration across page reloads
- New email and permanent mailbox deletion flows
- Responsive, mobile-first layout
- Toast notifications, loading states, and error handling (including 429 rate-limit backoff)

## Requirements

- A modern browser (Chrome, Firefox, Safari, Edge)
- [Node.js](https://nodejs.org) 16+ to run the included local server
- No API key is required to use the Mail.tm API

## Setup

1. Clone or copy these files into a folder:

   ```
   index.html
   style.css
   script.js
   server.js
   ```

2. Start the server:

   ```bash
   node server.js 8080
   ```

3. Open `http://localhost:8080` in your browser.

### Why a small server is included

Mail.tm's API currently restricts browser CORS to its own origin only, so a
static page hosted on another domain cannot call `api.mail.tm` directly from
the browser. The included `server.js` serves the static files and relays this
app's own requests to Mail.tm server-side. It is a private, same-origin relay,
not a public/generic proxy: requests from origins other than the server's own
host are rejected. The frontend auto-detects the relay (via `/api/health`) and
otherwise falls back to calling Mail.tm directly.

### Using a static host without the relay

If you deploy the three static files on a static host, the app attempts to call
Mail.tm directly. Whether this works depends on Mail.tm's current CORS policy.
For a reliably functional deployment, run the relay server (e.g. on your own
host or a serverless function) in front of the static files.

## Deployment

Any static hosting service works:

- Vercel / Netlify / GitHub Pages / Cloudflare Pages — upload the three files as-is
- A normal web server (nginx, Apache) can serve the folder directly

There is no build step. `server.js` runs on any Node.js 16+ host and only uses
built-in modules (no `npm install` needed).

## API usage and rate limits

- Base URL: `https://api.mail.tm`
- No API key required.
- General limit: 8 requests per second per IP. This app polls the inbox on a
  conservative 15-second interval and backs off when a `429` response is received.
- See https://mail.tm/ for the current API terms. Before any commercial launch,
  re-check the current Mail.tm terms of service.

## Attribution

Temporary email powered by Mail.tm — https://mail.tm/

## Security notes

- Received email HTML is sanitized before display (dangerous tags, event handlers,
  and unsafe URLs are stripped). If sanitization removes everything, the plain-text
  version is shown instead.
- Passwords and bearer tokens are never displayed or logged.
- The session stores only the minimum required information (address, account id, token)
  in `localStorage`.

## License

© 2026 TempMal.com. All rights reserved.
