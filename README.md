# 🎧 Pairwise Audio Ranker

A simple local web app for ranking audio clips by **pairwise comparison**. You
listen to two clips, pick the one you prefer, and an **Elo** rating builds up a
leaderboard. You can **trim** clips down to just the part you care about, and
**switch between users** so several people can rank the same clips independently.

No build step, no external dependencies — just Node.

## Features

- **Rank** – Listen to two clips side by side and pick a winner. Pairs are
  chosen to favour the least-compared clips so coverage stays even.
- **Trim** – Pick a source clip, set start/end points over a waveform, preview
  the selection, and save it as a new trimmed `.wav`. Trimmed clips become
  rankable immediately.
- **Per-user contexts** – A dropdown in the header switches the active user.
  Each user has their own independent ratings and history. Add new users on the
  fly (no auth — it's just a context switch).
- **Elo leaderboard** – Per-user ranking with rating, wins, losses and
  comparison counts.
- **Local JSON storage** – Everything is saved to `data.json` in the project
  folder. Easy to inspect, back up, or delete to start over.

## Requirements

- Node.js 18+ (tested on Node 22).
- A modern Chromium-based or Firefox browser (uses the Web Audio API to decode
  and trim clips client-side).

## Getting started

1. Put your audio clips in the `clips/` folder (or point the app at any folder —
   see below). Supported: `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.aac`,
   `.webm`, `.opus`.

2. Start the server:

   ```bash
   npm start
   ```

3. Open <http://localhost:4000>.

### Using a different clips folder

```bash
CLIPS_DIR=/path/to/your/audio npm start
```

Trimmed clips are written to a `trimmed/` sub-folder inside the clips folder.

### Changing the port

```bash
PORT=8080 npm start
```

## How trimming works

The browser decodes the chosen clip with the Web Audio API, you select a region,
and the app encodes just that region to a 16-bit PCM WAV and uploads it to the
server, which saves it under `clips/trimmed/`. This needs no `ffmpeg` or other
native tooling.

## Data & resetting

All ranking data lives in `data.json`:

```json
{
  "users": ["alice", "bob"],
  "ratings": { "alice": { "clip.wav": { "rating": 1024, "wins": 3, "losses": 1, "comparisons": 4 } } },
  "history": [ { "user": "alice", "winner": "a.wav", "loser": "b.wav", "ts": 0 } ]
}
```

Delete `data.json` to reset all ratings and users.

## Project layout

```
server.js          Zero-dependency Node HTTP server + JSON API
public/index.html  UI shell (Rank / Trim / Leaderboard tabs)
public/app.js      Front-end logic, Web Audio trimming, Elo display
public/style.css   Styling
clips/             Your audio clips (git-ignored); clips/trimmed/ holds trims
data.json          Ratings + users + history (git-ignored, auto-created)
```
