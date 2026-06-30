// Pairwise Audio Ranker — zero-dependency Node HTTP server.
//
// Responsibilities:
//   - Serve the static front-end (public/).
//   - List audio clips found in the source folder and any trimmed clips.
//   - Stream audio files to the browser for playback.
//   - Accept trimmed WAV uploads from the browser and store them on disk.
//   - Persist users, per-user Elo ratings and comparison history in data.json.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 4000;
// Folder that holds the original audio clips you want to rank. Override with
// CLIPS_DIR to point at any local folder on your machine.
const CLIPS_DIR = path.resolve(process.env.CLIPS_DIR || path.join(__dirname, "clips"));
// Trimmed clips produced in the browser are written here.
const TRIMMED_DIR = path.join(CLIPS_DIR, "trimmed");
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".webm", ".opus"]);
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

const DEFAULT_RATING = 1000;
const K_FACTOR = 32;

// ---------------------------------------------------------------------------
// Data persistence
// ---------------------------------------------------------------------------

function emptyData() {
  return { users: ["default"], ratings: {}, history: [] };
}

async function loadData() {
  try {
    const raw = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) && parsed.users.length ? parsed.users : ["default"],
      ratings: parsed.ratings && typeof parsed.ratings === "object" ? parsed.ratings : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return emptyData();
  }
}

let dataPromise = loadData();
let saveChain = Promise.resolve();

// Serialize writes so concurrent requests never corrupt data.json.
function persist(data) {
  saveChain = saveChain.then(() =>
    fsp.writeFile(DATA_FILE, JSON.stringify(data, null, 2)).catch((err) =>
      console.error("Failed to write data.json:", err)
    )
  );
  return saveChain;
}

// ---------------------------------------------------------------------------
// Clip discovery
// ---------------------------------------------------------------------------

async function listClips() {
  const clips = [];
  async function scan(dir, source) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext)) continue;
      // id is the path relative to CLIPS_DIR, using forward slashes.
      const abs = path.join(dir, entry.name);
      const rel = path.relative(CLIPS_DIR, abs).split(path.sep).join("/");
      clips.push({ id: rel, name: entry.name, source });
    }
  }
  await scan(CLIPS_DIR, "original");
  await scan(TRIMMED_DIR, "trimmed");
  clips.sort((a, b) => a.id.localeCompare(b.id));
  return clips;
}

// ---------------------------------------------------------------------------
// Elo
// ---------------------------------------------------------------------------

function getRating(ratings, user, clipId) {
  return ratings[user]?.[clipId]?.rating ?? DEFAULT_RATING;
}

function applyElo(data, user, winnerId, loserId) {
  if (!data.ratings[user]) data.ratings[user] = {};
  const userRatings = data.ratings[user];
  const ensure = (id) => {
    if (!userRatings[id]) userRatings[id] = { rating: DEFAULT_RATING, wins: 0, losses: 0, comparisons: 0 };
    return userRatings[id];
  };
  const w = ensure(winnerId);
  const l = ensure(loserId);
  const expW = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  const expL = 1 - expW;
  w.rating = Math.round(w.rating + K_FACTOR * (1 - expW));
  l.rating = Math.round(l.rating + K_FACTOR * (0 - expL));
  w.wins += 1;
  l.losses += 1;
  w.comparisons += 1;
  l.comparisons += 1;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, limitBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeFilename(name) {
  // Strip anything that isn't a safe filename character.
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "clip";
}

async function serveStatic(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// Stream an audio clip identified by its CLIPS_DIR-relative id, with Range support.
async function serveAudio(req, res, clipId) {
  const decoded = decodeURIComponent(clipId);
  const abs = path.resolve(CLIPS_DIR, decoded);
  // Prevent path traversal outside CLIPS_DIR.
  if (abs !== CLIPS_DIR && !abs.startsWith(CLIPS_DIR + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const type = MIME_BY_EXT[ext] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(abs).pipe(res);
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const data = await dataPromise;

  // GET /api/state — everything the UI needs to bootstrap.
  if (req.method === "GET" && url.pathname === "/api/state") {
    const clips = await listClips();
    sendJson(res, 200, { users: data.users, clips, ratings: data.ratings, clipsDir: CLIPS_DIR });
    return;
  }

  // POST /api/users — add a user. Body: { name }
  if (req.method === "POST" && url.pathname === "/api/users") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const name = String(body.name || "").trim();
    if (!name) return sendJson(res, 400, { error: "Name required" });
    if (!data.users.includes(name)) {
      data.users.push(name);
      await persist(data);
    }
    return sendJson(res, 200, { users: data.users });
  }

  // POST /api/vote — record a comparison. Body: { user, winner, loser }
  if (req.method === "POST" && url.pathname === "/api/vote") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const { user, winner, loser } = body;
    if (!user || !winner || !loser || winner === loser) {
      return sendJson(res, 400, { error: "user, winner and loser (distinct) are required" });
    }
    if (!data.users.includes(user)) data.users.push(user);
    applyElo(data, user, winner, loser);
    data.history.push({ user, winner, loser, ts: Date.now() });
    await persist(data);
    return sendJson(res, 200, { ratings: data.ratings[user] });
  }

  // POST /api/trim — save a trimmed WAV produced in the browser.
  // Headers: x-clip-name, x-source-id. Body: raw WAV bytes.
  if (req.method === "POST" && url.pathname === "/api/trim") {
    const buf = await readBody(req);
    if (!buf.length) return sendJson(res, 400, { error: "Empty upload" });
    await fsp.mkdir(TRIMMED_DIR, { recursive: true });
    const requested = safeFilename(req.headers["x-clip-name"] || "clip");
    const base = requested.replace(/\.wav$/i, "");
    let filename = `${base}.wav`;
    let i = 1;
    // Avoid clobbering an existing trimmed clip.
    while (fs.existsSync(path.join(TRIMMED_DIR, filename))) {
      filename = `${base}-${i++}.wav`;
    }
    await fsp.writeFile(path.join(TRIMMED_DIR, filename), buf);
    const id = path.relative(CLIPS_DIR, path.join(TRIMMED_DIR, filename)).split(path.sep).join("/");
    return sendJson(res, 200, { clip: { id, name: filename, source: "trimmed" } });
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/audio/")) {
      await serveAudio(req, res, url.pathname.slice("/audio/".length));
      return;
    }

    // Static files.
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    await serveStatic(res, filePath);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

async function start() {
  await fsp.mkdir(CLIPS_DIR, { recursive: true });
  await fsp.mkdir(TRIMMED_DIR, { recursive: true });
  server.listen(PORT, () => {
    console.log(`\nPairwise Audio Ranker running at http://localhost:${PORT}`);
    console.log(`Serving clips from: ${CLIPS_DIR}`);
    console.log(`Trimmed clips are saved to: ${TRIMMED_DIR}\n`);
  });
}

start();
