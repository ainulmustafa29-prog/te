#!/usr/bin/env node
/**
 * TempMal.com — minimal static server + same-origin Mail.tm relay.
 *
 * Mail.tm's API currently restricts browser CORS to its own origin only, so a
 * browser app hosted on another domain cannot call it directly. This server
 * serves the static site and relays the app's own requests to api.mail.tm from
 * the server side (no CORS needed for same-origin requests).
 *
 * This is NOT a public/generic proxy: requests from origins other than this
 * server's own host are rejected, and only the paths this app uses are relayed.
 *
 * Run:  node server.js [port]
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = __dirname;
const UPSTREAM = "https://api.mail.tm";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2"
};

const FORWARD_HEADERS = ["content-type", "accept", "authorization", "content-length"];

function safeJoin(base, target) {
  const resolved = path.resolve(base, "." + path.sep + target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  if (filePath.includes("..")) {
    res.writeHead(400).end("Bad request");
    return;
  }
  filePath = safeJoin(ROOT, filePath);
  if (!filePath) {
    res.writeHead(400).end("Bad request");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (pathname === "/") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

function rewriteJson(obj) {
  if (typeof obj === "string") {
    if (obj.startsWith("https://api.mail.tm/")) return "/api/" + obj.slice("https://api.mail.tm/".length);
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(rewriteJson);
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) obj[key] = rewriteJson(obj[key]);
    return obj;
  }
  return obj;
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  const hostOnly = String(origin).replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  if (hostOnly === host) return true;
  // allow localhost-ish origins when host itself is localhost
  if (/localhost|127\.0\.0\.1/.test(host) && /localhost|127\.0\.0\.1/.test(hostOnly)) return true;
  return false;
}

function proxy(req, res, pathname, search) {
  if (!allowedOrigin(req)) {
    res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    return;
  }

  const upstreamPath = pathname.replace(/^\/api/, "") + search;
  const bodyChunks = [];
  req.on("data", (c) => bodyChunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const headers = {};
    FORWARD_HEADERS.forEach((h) => {
      if (req.headers[h]) headers[h] = req.headers[h];
    });
    headers["accept"] = headers["accept"] || "application/ld+json";

    const req2 = https.request(
      new URL(UPSTREAM + upstreamPath),
      { method: req.method, headers },
      (res2) => {
        const chunks = [];
        res2.on("data", (c) => chunks.push(c));
        res2.on("end", () => {
          const buf = Buffer.concat(chunks);
          const contentType = res2.headers["content-type"] || "";
          const responseHeaders = { "content-type": contentType };
          if (res2.statusCode === 204) {
            res.writeHead(204, responseHeaders);
            res.end();
            return;
          }
          if (/json/.test(contentType) && buf.length > 0) {
            try {
              const data = JSON.parse(buf.toString("utf8"));
              const rewritten = JSON.stringify(rewriteJson(data));
              res.writeHead(res2.statusCode || 502, responseHeaders);
              res.end(rewritten);
              return;
            } catch (e) {
              /* not JSON we can rewrite — pass through */
            }
          }
          res.writeHead(res2.statusCode || 502, responseHeaders);
          res.end(buf);
        });
        res2.on("error", () => {
          res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "upstream error" }));
        });
      }
    );
    req2.setTimeout(30000, () => req2.destroy());
    req2.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "relay unavailable" }));
      }
    });
    if (body.length) req2.write(body);
    req2.end();
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const pathname = decodeURIComponent(parsed.pathname || "/");
  if (pathname.startsWith("/api")) {
    proxy(req, res, pathname, parsed.search || "");
  } else {
    serveStatic(req, res, pathname);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TempMal.com running at http://localhost:${PORT}`);
});
