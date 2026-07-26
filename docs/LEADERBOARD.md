# Leaderboard setup (simpleboards.dev)

The game is fully playable without any of this. With no configuration it keeps a
local leaderboard in `localStorage` and says so on the score screen.

There are two ways to run the online board:

| | Key location | Needs |
|---|---|---|
| **Proxy mode** (recommended) | A Vercel environment variable | A free Vercel account |
| **Direct mode** (fallback) | Inlined into the client bundle, extractable | Nothing |

---

## Proxy mode

```
itch.io (static, no key)  →  your Vercel function  →  api.simpleboards.dev
```

`api/scores.ts` is a single Vercel Edge function that holds the API key and
proxies two operations. It is about 300 lines, has no dependencies, and is
already written — you only have to deploy it.

### 1. Deploy

Push this repo and import it at <https://vercel.com/new>. Vercel detects Vite,
builds the game to `dist/`, and turns `api/scores.ts` into a function. You get
both a playable web build and the endpoint.

> Deploying the game to Vercel as well is optional but free, and a URL is easier
> to share than a zip while you are still iterating.

### 2. Set the environment variables

In the Vercel project, under **Settings → Environment Variables**:

| Variable | Required | Notes |
|---|---|---|
| `SIMPLEBOARDS_API_KEY` | yes | The secret. Never sent to a client. |
| `SIMPLEBOARDS_LEADERBOARD_ID` | yes | |
| `SIMPLEBOARDS_BASE_URL` | no | Defaults to `https://api.simpleboards.dev` |
| `LEADERBOARD_ALLOWED_ORIGINS` | no | Comma-separated. Defaults to `*`. |
| `LEADERBOARD_MAX_SCORE` | no | Plausibility ceiling, defaults to `250000` |

Redeploy after adding them — Vercel does not apply new variables to an existing
deployment.

If you want to restrict origins, the value for an itch.io HTML5 game is:

```
https://html-classic.itch.zone,http://localhost:5173
```

itch.io serves browser games from an iframe on `html-classic.itch.zone`, not
from your `*.itch.io` page. Read the caveat under "What this does not buy you"
before bothering.

### 3. Point the game at it

In `.env` at the project root (gitignored — do not commit it):

```dotenv
VITE_LEADERBOARD_PROXY=https://your-project.vercel.app
```

That is a **public URL**, not a secret. It is the only leaderboard variable the
game needs in proxy mode, and it takes precedence over any direct-mode variables
left over from an earlier setup.

Then rebuild — Vite inlines `VITE_*` at build time:

```bash
npm run package
```

### 4. Check it

```bash
npm run proxy     # runs the function under Node against a stubbed upstream
```

That exercises validation, normalisation, CORS and the "the key never comes
back" property without deploying anything. It does **not** prove your key or
board id are right — only a real run does that. See the checklist below.

---

## What the proxy does and does not buy you

**It does keep the key off the client.** That is the whole point, and it works —
nothing in the shipped bundle can be used to talk to simpleboards.dev directly.
`npm run proxy` asserts the key never appears in any client-visible response.

**It does not make scores trustworthy.** Anyone can POST a number to the
endpoint. CORS is a browser politeness mechanism, not an authorisation one, and
a determined player has curl. The proxy validates:

- score is a finite, non-negative integer below `LEADERBOARD_MAX_SCORE`
- `playerId` is present and length-capped
- names are sanitised server-side (control characters and `< > & " '` stripped,
  whitespace collapsed, 16 characters)
- metadata is **whitelisted** to the five known run statistics, so nobody can
  write arbitrary JSON into your board under your key

That rejects nonsense, not lies. A board that genuinely has to be trusted needs
the server to replay the run from an input log and check the score itself, which
is a much bigger thing than a jam needs. **Expect to moderate.**

The default ceiling of 250,000 is roughly three times the absolute theoretical
maximum — a 120-second match (the `CLOCK.maxSeconds` cap) at ~0.6 bounces a
second, every bounce a 9 at a multiplier around ×21 with a maxed ×2.2 combo,
comes to about 85,000. It is set loose deliberately: rejecting a real player's
best run on jam day is worse than letting an implausible one through.

---

## Direct mode (no server)

Set these instead, and leave `VITE_LEADERBOARD_PROXY` unset:

```dotenv
VITE_SIMPLEBOARDS_LEADERBOARD_ID=your-leaderboard-id
VITE_SIMPLEBOARDS_API_KEY=your-api-key
```

The key ends up in the JavaScript, where anyone who looks can extract it. This
is inherent to a static build with no server, not a bug in the integration. Use
a submit-scoped key if simpleboards.dev offers one.

---

## ⚠️ The request shape has not been executed against the live service

The container this was built in blocks `simpleboards.dev` and
`api.simpleboards.dev` at the network policy (403 on CONNECT), so their docs
could not be read and the API could not be called. The request shape was
reconstructed from their published client libraries:

- `POST {base}/api/entries` with an `x-api-key` header
- body `{ leaderboardId, playerId, playerDisplayName, score, metadata }`

Both modes are written defensively around that: two candidate read paths, and
tolerant response parsing (bare array, `entries`, `data`, `items` or `results`;
names under several possible keys).

**In proxy mode that uncertainty lives on the server**, which is the right place
for it — fixing a wrong guess is a redeploy, not a rebuilt and re-uploaded game,
and the client only ever sees one normalised shape.

---

## Verification checklist

Run once from a machine that can reach the service.

- [ ] `curl 'https://your-project.vercel.app/api/scores?limit=5'` returns
      `{"entries":[...],"source":"simpleboards"}`.
      - `503` → the environment variables are missing, or you did not redeploy
      - `502` → the key, the board id, or both candidate paths are wrong
- [ ] Note the **`x-upstream-path`** response header. That is which of the two
      candidate read paths actually worked:

      ```bash
      curl -sD- -o/dev/null 'https://your-project.vercel.app/api/scores' | grep -i x-upstream
      ```

      Once you know, delete the other from `candidates` in `readBoard()` so
      every board load stops making a failing request first.
- [ ] Play a run, enter a name, press **Submit score**.
- [ ] The button becomes **Submitted** with a tick, and no warning appears under
      the board.
- [ ] The board lists real entries and the notice line is empty. A warning there
      means it silently fell back to local scores.
- [ ] Your score is on simpleboards.dev, with the right name and value.
- [ ] Confirm `metadata` arrived in a form the service accepts. It is currently
      sent as a **JSON string**; if the API wants an object, drop the
      `JSON.stringify(...)` in `writeScore()`.

---

## If it does not work

Failures are designed to be visible rather than silent — the score screen shows
the reason under the board, and in proxy mode that reason is the proxy's own
message rather than a bare status code.

| Symptom | Likely cause |
|---|---|
| "Online board is not configured" | `.env` missing, or the build ran before `.env` existed |
| "Leaderboard is not configured on the server." | Vercel environment variables missing, or set but not redeployed |
| "Upstream read failed: HTTP 401" | Wrong or expired API key |
| "Upstream read failed: HTTP 404" | Wrong leaderboard ID, or neither candidate path is right |
| "Score is outside the plausible range." | Raise `LEADERBOARD_MAX_SCORE` |
| Board loads but submit fails with a CORS error | `LEADERBOARD_ALLOWED_ORIGINS` is set and does not include the origin the game is actually served from — check the browser console, it names it |
| "Request timed out" | Service unreachable; the client timeout is `LEADERBOARD.timeoutMs` in `src/core/Config.ts` |
| Submits fine, board stays empty | The write path is right and the read path is not — check `x-upstream-path` |

Nothing here blocks shipping. If the leaderboard is broken on jam day the game
still plays, still scores, and still keeps a local board.
