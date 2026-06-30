// Pairwise Audio Ranker — front-end logic.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  users: [],
  clips: [],
  ratings: {}, // { user: { clipId: {rating, wins, losses, comparisons} } }
  currentUser: null,
  pair: null, // [clipA, clipB]
};

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
// Cache decoded AudioBuffers for the trimmer keyed by clip id.
const decodedCache = new Map();

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function loadState() {
  const data = await api("/api/state");
  state.users = data.users;
  state.clips = data.clips;
  state.ratings = data.ratings;
  if (!state.currentUser || !state.users.includes(state.currentUser)) {
    state.currentUser = state.users[0];
  }
  renderUsers();
  renderActiveTab();
}

// ---------------------------------------------------------------------------
// User switching
// ---------------------------------------------------------------------------

function renderUsers() {
  const sel = $("#user-select");
  sel.innerHTML = "";
  for (const u of state.users) {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    if (u === state.currentUser) opt.selected = true;
    sel.appendChild(opt);
  }
}

$("#user-select").addEventListener("change", (e) => {
  state.currentUser = e.target.value;
  // A new context means a fresh pair and a refreshed board.
  state.pair = null;
  renderActiveTab();
});

$("#add-user-btn").addEventListener("click", async () => {
  const name = prompt("New user name:");
  if (!name || !name.trim()) return;
  const data = await api("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  state.users = data.users;
  state.currentUser = name.trim();
  renderUsers();
  renderActiveTab();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let activeTab = "rank";

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${activeTab}`));
    renderActiveTab();
  });
});

function renderActiveTab() {
  if (activeTab === "rank") renderRank();
  else if (activeTab === "trim") renderTrimSources();
  else if (activeTab === "board") renderBoard();
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function userRatings() {
  return state.ratings[state.currentUser] || {};
}

// Choose a pair, favouring clips that have been compared the fewest times so
// coverage stays even.
function choosePair() {
  if (state.clips.length < 2) return null;
  const ratings = userRatings();
  const count = (id) => ratings[id]?.comparisons ?? 0;
  const sorted = [...state.clips].sort((a, b) => count(a.id) - count(b.id));
  // First contender: among the least-compared, pick at random.
  const minCount = count(sorted[0].id);
  const leastPool = sorted.filter((c) => count(c.id) === minCount);
  const first = leastPool[Math.floor(Math.random() * leastPool.length)];
  // Second contender: a different clip, weighted toward fewer comparisons.
  const rest = state.clips.filter((c) => c.id !== first.id);
  rest.sort((a, b) => count(a.id) - count(b.id));
  const topHalf = rest.slice(0, Math.max(1, Math.ceil(rest.length / 2)));
  const second = topHalf[Math.floor(Math.random() * topHalf.length)];
  // Randomise display order.
  return Math.random() < 0.5 ? [first, second] : [second, first];
}

function renderRank() {
  const empty = $("#rank-empty");
  const arena = $("#rank-arena");
  if (state.clips.length < 2) {
    empty.classList.remove("hidden");
    arena.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  arena.classList.remove("hidden");

  if (!state.pair) state.pair = choosePair();
  const [a, b] = state.pair;
  setContender("a", a);
  setContender("b", b);

  const total = (state.ratings[state.currentUser] &&
    Object.values(state.ratings[state.currentUser]).reduce((s, r) => s + r.wins, 0)) || 0;
  $("#vote-count").textContent = `${total} comparison${total === 1 ? "" : "s"} recorded for ${state.currentUser}`;
}

function setContender(side, clip) {
  $(`[data-name="${side}"]`).textContent = clip.name + (clip.source === "trimmed" ? "  (trimmed)" : "");
  const audio = $(`[data-audio="${side}"]`);
  audio.src = `/audio/${encodeURIComponent(clip.id)}`;
  audio.load();
}

async function vote(winnerSide) {
  if (!state.pair) return;
  const [a, b] = state.pair;
  const winner = winnerSide === "a" ? a : b;
  const loser = winnerSide === "a" ? b : a;
  $$(".pick-btn").forEach((btn) => (btn.disabled = true));
  try {
    const data = await api("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: state.currentUser, winner: winner.id, loser: loser.id }),
    });
    state.ratings[state.currentUser] = data.ratings;
  } catch (err) {
    alert("Failed to record vote: " + err.message);
  } finally {
    $$(".pick-btn").forEach((btn) => (btn.disabled = false));
  }
  // Pause any playing audio and present the next pair.
  $$("#rank-arena audio").forEach((el) => el.pause());
  state.pair = choosePair();
  renderRank();
}

$$(".pick-btn").forEach((btn) => btn.addEventListener("click", () => vote(btn.dataset.pick)));
$("#skip-btn").addEventListener("click", () => {
  $$("#rank-arena audio").forEach((el) => el.pause());
  state.pair = choosePair();
  renderRank();
});

// ---------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------

let previewSource = null;

function renderTrimSources() {
  const sel = $("#trim-source");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— select a clip —</option>';
  for (const clip of state.clips) {
    const opt = document.createElement("option");
    opt.value = clip.id;
    opt.textContent = clip.name + (clip.source === "trimmed" ? "  (trimmed)" : "");
    sel.appendChild(opt);
  }
  if (prev && state.clips.some((c) => c.id === prev)) sel.value = prev;
}

$("#trim-source").addEventListener("change", async (e) => {
  const id = e.target.value;
  const trimmer = $("#trimmer");
  if (!id) {
    trimmer.classList.add("hidden");
    return;
  }
  $("#trim-status").textContent = "Loading and decoding audio…";
  trimmer.classList.remove("hidden");
  try {
    const buffer = await loadDecoded(id);
    setupTrimmer(buffer, id);
    $("#trim-status").textContent = `Duration: ${buffer.duration.toFixed(2)}s`;
  } catch (err) {
    $("#trim-status").textContent = "Could not decode this file in the browser: " + err.message;
  }
});

async function loadDecoded(id) {
  if (decodedCache.has(id)) return decodedCache.get(id);
  const res = await fetch(`/audio/${encodeURIComponent(id)}`);
  const arr = await res.arrayBuffer();
  const buffer = await audioCtx.decodeAudioData(arr);
  decodedCache.set(id, buffer);
  return buffer;
}

let currentBuffer = null;

function setupTrimmer(buffer, id) {
  currentBuffer = buffer;
  const start = $("#start-range");
  const end = $("#end-range");
  start.value = 0;
  end.value = 1000;
  updateTrimLabels();
  drawWaveform(buffer);
  // Suggest a name based on the source.
  const src = state.clips.find((c) => c.id === id);
  const base = src ? src.name.replace(/\.[^.]+$/, "") : "clip";
  $("#trim-name").value = `${base}-trim`;
}

function rangeToSeconds(value) {
  if (!currentBuffer) return 0;
  return (Number(value) / 1000) * currentBuffer.duration;
}

function updateTrimLabels() {
  $("#start-label").textContent = rangeToSeconds($("#start-range").value).toFixed(2);
  $("#end-label").textContent = rangeToSeconds($("#end-range").value).toFixed(2);
  drawSelectionOverlay();
}

$("#start-range").addEventListener("input", () => {
  const start = $("#start-range");
  const end = $("#end-range");
  if (Number(start.value) > Number(end.value)) end.value = start.value;
  updateTrimLabels();
});
$("#end-range").addEventListener("input", () => {
  const start = $("#start-range");
  const end = $("#end-range");
  if (Number(end.value) < Number(start.value)) start.value = end.value;
  updateTrimLabels();
});

function drawWaveform(buffer) {
  const canvas = $("#waveform");
  // Match the canvas backing store to its displayed width for crisp rendering.
  canvas.width = canvas.clientWidth || 900;
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const ch = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / width));
  ctx.strokeStyle = "#4b5573";
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) {
      const sample = ch[x * step + i] || 0;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }
    const y1 = ((1 + min) / 2) * height;
    const y2 = ((1 + max) / 2) * height;
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();
  drawSelectionOverlay();
}

function drawSelectionOverlay() {
  const canvas = $("#waveform");
  if (!currentBuffer || !canvas.width) return;
  // Redraw waveform then overlay the selected region.
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const startX = (Number($("#start-range").value) / 1000) * width;
  const endX = (Number($("#end-range").value) / 1000) * width;
  // Shade outside the selection.
  ctx.fillStyle = "rgba(15,17,23,0.6)";
  ctx.fillRect(0, 0, startX, height);
  ctx.fillRect(endX, 0, width - endX, height);
  // Selection borders.
  ctx.strokeStyle = "#4ad991";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(startX, 0); ctx.lineTo(startX, height);
  ctx.moveTo(endX, 0); ctx.lineTo(endX, height);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function stopPreview() {
  if (previewSource) {
    try { previewSource.stop(); } catch {}
    previewSource = null;
  }
}

$("#preview-btn").addEventListener("click", () => {
  if (!currentBuffer) return;
  stopPreview();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const startSec = rangeToSeconds($("#start-range").value);
  const endSec = rangeToSeconds($("#end-range").value);
  const src = audioCtx.createBufferSource();
  src.buffer = currentBuffer;
  src.connect(audioCtx.destination);
  src.start(0, startSec, Math.max(0.01, endSec - startSec));
  previewSource = src;
});
$("#stop-btn").addEventListener("click", stopPreview);

$("#save-trim-btn").addEventListener("click", async () => {
  if (!currentBuffer) return;
  const startSec = rangeToSeconds($("#start-range").value);
  const endSec = rangeToSeconds($("#end-range").value);
  if (endSec - startSec < 0.05) {
    $("#trim-status").textContent = "Selection is too short.";
    return;
  }
  const name = ($("#trim-name").value || "clip").trim();
  $("#trim-status").textContent = "Encoding and saving…";
  const sliced = sliceBuffer(currentBuffer, startSec, endSec);
  const wav = encodeWav(sliced);
  try {
    const data = await api("/api/trim", {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "x-clip-name": name },
      body: wav,
    });
    // Add to local state so it's instantly rankable.
    state.clips.push(data.clip);
    state.clips.sort((a, b) => a.id.localeCompare(b.id));
    renderTrimSources();
    $("#trim-status").textContent = `Saved "${data.clip.name}" — it's now available in the Rank tab.`;
  } catch (err) {
    $("#trim-status").textContent = "Save failed: " + err.message;
  }
});

// Extract [startSec, endSec) into a new AudioBuffer.
function sliceBuffer(buffer, startSec, endSec) {
  const rate = buffer.sampleRate;
  const startFrame = Math.floor(startSec * rate);
  const endFrame = Math.min(buffer.length, Math.floor(endSec * rate));
  const frames = Math.max(1, endFrame - startFrame);
  const out = audioCtx.createBuffer(buffer.numberOfChannels, frames, rate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch).subarray(startFrame, endFrame);
    out.getChannelData(ch).set(src);
  }
  return out;
}

// Encode an AudioBuffer to a 16-bit PCM WAV ArrayBuffer.
function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels.
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let s = Math.max(-1, Math.min(1, channels[ch][i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return ab;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function renderBoard() {
  $("#board-user").textContent = state.currentUser;
  const ratings = userRatings();
  const rows = state.clips
    .map((c) => ({ clip: c, r: ratings[c.id] }))
    .filter((row) => row.r) // only clips this user has actually compared
    .sort((a, b) => b.r.rating - a.r.rating);

  const tbody = $("#board-table tbody");
  tbody.innerHTML = "";
  if (!rows.length) {
    $("#board-empty").classList.remove("hidden");
    $("#board-table").classList.add("hidden");
    return;
  }
  $("#board-empty").classList.add("hidden");
  $("#board-table").classList.remove("hidden");

  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    if (i === 0) tr.classList.add("rank-1");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(row.clip.name)}${row.clip.source === "trimmed" ? ' <span class="muted">(trimmed)</span>' : ""}</td>
      <td class="rating">${row.r.rating}</td>
      <td>${row.r.wins}</td>
      <td>${row.r.losses}</td>
      <td>${row.r.comparisons}</td>`;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadState().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px;color:#ff6b6b">Failed to load app: ${escapeHtml(err.message)}</p>`;
});
