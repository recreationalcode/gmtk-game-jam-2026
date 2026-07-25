# Leaderboard setup (simpleboards.dev)

The game is fully playable without this. With no configuration it keeps a
local leaderboard in `localStorage` and says so on the score screen.

---

## ⚠️ Two things to know before you wire it up

### 1. The integration has not been executed against the live service

The container this was built in blocks `simpleboards.dev` and
`api.simpleboards.dev` at the network policy (403 on CONNECT), so their docs
could not be read and the API could not be called. The request shape in
`src/net/Leaderboard.ts` was reconstructed from their published client
libraries:

- `POST {base}/api/entries` with an `x-api-key` header
- body `{ leaderboardId, playerId, playerDisplayName, score, metadata }`

The code is written defensively around that uncertainty — it tries two
candidate endpoint shapes for reads, parses responses tolerantly (bare array,
`entries`, `data`, `items`, or `results`; names under several possible keys),
and falls back to the local board on any failure.

**It still needs one verification run from a machine that can reach the
service.** See the checklist below.

### 2. The API key ships in the client bundle

A static itch.io game has no server of its own, so any key it uses is
extractable from the JavaScript by anyone who looks. This is inherent to
client-only leaderboards, not a bug in this integration.

Mitigations, in order of usefulness:

- Use a **submit-scoped key** if SimpleBoards offers one, never an admin key.
- Expect to **moderate** the board occasionally.
- Treat scores as **untrusted**. The client sends its own number; nothing
  prevents a determined player from sending a different one.

If the board matters more than convenience, the real fix is a tiny serverless
proxy that holds the key and does basic sanity checks — out of scope for a jam,
but the shape to reach for afterwards.

---

## Setup

1. Create a board at <https://simpleboards.dev> and note the **leaderboard ID**
   and **API key**.

2. Create `.env` in the project root (it is gitignored — do not commit it):

   ```dotenv
   VITE_SIMPLEBOARDS_LEADERBOARD_ID=your-leaderboard-id
   VITE_SIMPLEBOARDS_API_KEY=your-api-key
   # Only if their base URL differs from the default:
   # VITE_SIMPLEBOARDS_BASE_URL=https://api.simpleboards.dev
   ```

3. Rebuild. Vite inlines `VITE_`-prefixed variables at build time, so the values
   must be present **when you build**, not when you upload:

   ```bash
   npm run package
   ```

---

## Verification checklist

Run this once from a machine with network access to the service.

- [ ] Play a run, enter a name, press **Submit score**.
- [ ] The button becomes "Submitted" and no warning appears under the board.
- [ ] The board lists real entries and the notice line is empty (a warning means
      it silently fell back to local scores).
- [ ] Check the board on simpleboards.dev — your score is there, with the right
      name and value.
- [ ] Open the browser devtools Network tab and confirm which request succeeded:
      - `GET /api/entries?leaderboardId=…` **or**
      - `GET /api/leaderboards/{id}/entries`

      Once you know which one the service actually uses, delete the other from
      the `candidates` array in `Leaderboard.top()` so every page load stops
      making a failing request first.
- [ ] Confirm the submitted `metadata` field arrives in a form the service
      accepts. It is currently sent as a **JSON string**; if the API wants an
      object, drop the `JSON.stringify(...)` in `Leaderboard.submit()`.

---

## If it does not work

The failure is designed to be visible rather than silent — the score screen
shows the reason under the board. Common cases:

| Symptom | Likely cause |
|---|---|
| "Online board is not configured" | `.env` missing, or the build ran before `.env` existed |
| "online board unreachable (HTTP 401)" | Wrong or expired API key |
| "online board unreachable (HTTP 404)" | Wrong leaderboard ID, or neither endpoint shape is right |
| "Request timed out" | Service unreachable; the timeout is `LEADERBOARD.timeoutMs` in `src/core/Config.ts` |
| Submits fine, board stays empty | The write endpoint is right but the read endpoint is not — check the Network tab |

Nothing here blocks shipping. If the leaderboard is broken on jam day the game
still plays, still scores, and still keeps a local board.
