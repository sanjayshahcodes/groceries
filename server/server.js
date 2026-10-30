#!/usr/bin/env node
"use strict";

/**
 * Sunday Basket server.
 *
 * Serves the app and keeps its data, so two phones see the same thing. No
 * dependencies: node's own http/fs, a JSON file, and Server-Sent Events for
 * live updates. The whole dataset is a few dozen kilobytes — a household's
 * meals, not a product catalogue — so a file rewritten atomically on change is
 * the right amount of machinery. Swapping in SQLite later means replacing
 * load/persist and nothing else.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.APP_PASSWORD || "";

/* Mirrors Store.collections in index.html. A write to anything else is refused
   rather than silently creating a collection from a typo. */
const COLLECTIONS = [
  "meals", "staples", "pantry", "plan", "items", "adjust", "snacks", "picks"
];

/* ----------------------------- storage ----------------------------- */

let state = loadState();

function loadState() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("Could not read " + DATA_FILE + ": " + e.message);
      console.error("Refusing to start so the file is not overwritten.");
      process.exit(1);
    }
  }
  const out = {};
  COLLECTIONS.forEach(function (c) { out[c] = parsed[c] || {}; });
  return out;
}

/* Coalesce bursts (a form that writes on each keystroke) into one write, and
   go through a temp file so a crash mid-write cannot truncate the real one. */
let pending = null;
function persist() {
  if (pending) return;
  pending = setTimeout(function () {
    pending = null;
    const tmp = DATA_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error("Write failed: " + e.message);
    }
  }, 60);
}

/* ------------------------- live updates (SSE) ------------------------ */

const listeners = new Set();

function broadcast(event) {
  const frame = "data: " + JSON.stringify(event) + "\n\n";
  listeners.forEach(function (res) {
    try { res.write(frame); } catch (e) { listeners.delete(res); }
  });
}

/* --------------------------- http plumbing --------------------------- */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function sendJSON(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

/* A single shared passphrase, off unless APP_PASSWORD is set. Enough for a
   household behind a tunnel; not an account system, and not pretending to be. */
function authorized(req) {
  if (!PASSWORD) return true;
  const cookie = req.headers.cookie || "";
  if (cookie.split(/;\s*/).indexOf("sb_key=" + PASSWORD) >= 0) return true;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("key") === PASSWORD;
}

function maybeSetCookie(req, res) {
  if (!PASSWORD) return;
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("key") === PASSWORD) {
    res.setHeader("set-cookie",
      "sb_key=" + PASSWORD + "; Path=/; Max-Age=31536000; SameSite=Lax");
  }
}

/* ------------------------------ routes ------------------------------ */

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    res.end("Add ?key=… to the address once, and it is remembered.");
    return;
  }
  maybeSetCookie(req, res);

  /* everything the app holds, in one request */
  if (route === "/api/state" && req.method === "GET") {
    return sendJSON(res, 200, state);
  }

  /* live updates: one open connection per device */
  if (route === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write("retry: 2000\n\n");
    listeners.add(res);
    const beat = setInterval(function () {
      try { res.write(": beat\n\n"); } catch (e) { /* closed */ }
    }, 25000);
    req.on("close", function () {
      clearInterval(beat);
      listeners.delete(res);
    });
    return;
  }

  /* /api/<collection>/<id> */
  const m = route.match(/^\/api\/([a-z]+)\/([A-Za-z0-9_\-.~:@+]{1,200})$/);
  if (m) {
    const coll = m[1];
    const id = m[2];
    if (COLLECTIONS.indexOf(coll) < 0) {
      return sendJSON(res, 404, { error: "unknown collection: " + coll });
    }

    if (req.method === "PUT") {
      let doc;
      try {
        doc = JSON.parse(await readBody(req, 512 * 1024));
      } catch (e) {
        return sendJSON(res, 400, { error: "bad body: " + e.message });
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return sendJSON(res, 400, { error: "document must be an object" });
      }
      delete doc.id;
      state[coll][id] = doc;
      persist();
      broadcast({ type: "put", coll: coll, id: id, doc: doc });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      delete state[coll][id];
      persist();
      broadcast({ type: "del", coll: coll, id: id });
      return sendJSON(res, 200, { ok: true });
    }

    res.writeHead(405, { allow: "PUT, DELETE" });
    return res.end();
  }

  if (route.startsWith("/api/")) {
    return sendJSON(res, 404, { error: "no such endpoint" });
  }

  /* static: the app itself */
  const rel = route === "/" ? "index.html" : route.replace(/^\/+/, "");
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(buf);
  });
});

/* ------------------------------ start ------------------------------- */

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

server.listen(PORT, "0.0.0.0", function () {
  const counts = COLLECTIONS
    .map(function (c) { return c + ":" + Object.keys(state[c]).length; })
    .join("  ");
  const lan = lanAddress();
  console.log("Sunday Basket");
  console.log("  on this machine   http://localhost:" + PORT);
  if (lan) console.log("  from your phone   http://" + lan + ":" + PORT);
  console.log("  data              " + DATA_FILE);
  console.log("  documents         " + counts);
  if (!PASSWORD) console.log("  auth              off (set APP_PASSWORD before exposing it)");
});

function shutdown() {
  if (pending) {
    clearTimeout(pending);
    pending = null;
    try {
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(state, null, 2));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) { /* best effort */ }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
