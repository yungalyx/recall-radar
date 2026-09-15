# Recall Radar

**"Alexa, is anything in my house recalled?"**

A household keeps an inventory of things it owns (added by voice/chat, or imported from an
Amazon "Your Orders" CSV export). Recall Radar cross-references that inventory against public
recall databases — CPSC (consumer products), NHTSA (vehicles), openFDA (food/drug/device) — and
returns explainable recall cards with confidence scores and step-by-step remedy plans.

Built for the Amazon "Build, Ship, Shape" Devpost hackathon, Alexa+ track (deadline 2026-10-23),
and entered as **Recall Radar Voice** in the AssemblyAI Voice Agent Hackathon on lablab.ai
(Sep 1–30, 2026). The rules' explicit fallback for entries without partner Alexa+ hardware access
is a "simulated Alexa+ experience in a web app" — that's what `public/index.html` is: an
Echo-Show-shaped chat client, served by the same process, talking to the MCP server over HTTP.

## Voice

Press 🎤 and talk to it. Speech in is **AssemblyAI Universal-Streaming**; speech out is the
browser's own `speechSynthesis`, so the voice loop adds no dependencies and no build step.

```
 mic ──PCM16 @16 kHz──► AssemblyAI  wss://streaming.assemblyai.com/v3/ws  ──Turn──┐
   │   (AudioWorklet)      ▲                                                      │
   │                       │ short-lived token                                    ▼
   └───────────────────────┴── GET /stt-token ◄── this server            src/intent.js
                                (bearer-gated)                                    │
                                                                                  ▼
                                                              MCP tools ──► spoken answer
```

Two decisions worth calling out:

- **The API key never reaches the browser and audio never reaches this server.** `/stt-token`
  mints a 5-minute AssemblyAI token, behind the same bearer auth as `/mcp` because minting spends
  real credit. The browser then opens the microphone WebSocket to AssemblyAI directly.
- **The intent router had to be rewritten for speech.** Streaming transcripts arrive *formatted* —
  `"Details one."`, not `details 1` — so spelled-out numbers, leading capitals and terminal
  punctuation all have to parse. That broke every follow-up command ("details 1", "help me fix 1",
  "remove #2") until `src/intent.js` learned to read them. The router now lives in one
  dependency-free module that the page imports from `/intent.js` and `node --test` tests directly,
  so the thing shipped to the browser is the thing under test.

`npm test` covers the router against real spoken phrasings. To prove the *audio* path end to end —
which no unit test can — `scripts/voice-smoke.mjs` streams a real recording through the live API:

```
sox speech.ogg -r 16000 -c 1 -b 16 -e signed-integer -t raw speech.raw
ASSEMBLYAI_API_KEY=... node scripts/voice-smoke.mjs speech.raw
# Turn end_of_turn=true formatted=true :: "A rolling stone gathers no moss."
```

## Architecture

```
                         ┌─────────────────────────────────────────┐
                         │            node:http  (server.js)        │
                         │                                          │
  Browser ───GET /────►  │  public/index.html (simulated Alexa+)    │
  (PKCE in JS)           │    - OAuth PKCE flow against our own AS   │
                         │    - AssemblyAI streaming STT + TTS out   │
                         │    - shared intent router (/intent.js)    │
                         │    - renders MCP results as cards         │
                         │                                          │
  MCP Inspector /   ───► │  /mcp  (Streamable HTTP, spec 2025-11-25) │
  Claude / Alexa+        │    - Origin check, Bearer JWT check       │
  (Bearer JWT)           │    - one McpServer instance per session,  │
                         │      bound to the OAuth subject           │
                         │           │                               │
                         │           ▼                               │
                         │  mcp.js — tools: add_item, list_items,    │
                         │    remove_item, import_orders,            │
                         │    check_recalls, recall_details,         │
                         │    start_remedy · resource:               │
                         │    household://inventory                  │
                         │           │            │                  │
                         │     orders.js      match.js                │
                         │   (Amazon CSV      (tokenise, dice-       │
                         │    parser)          bigram fuzzy match,    │
                         │           │         confidence + reason,   │
                         │           │         optional LLM rerank)   │
                         │           ▼            │                   │
                         │        recalls.js ◄────┘                   │
                         │   (CPSC / NHTSA+vPIC / openFDA connectors, │
                         │    normalise to one shape, TTL cache)      │
                         │           │                                │
                         │  /authorize /token /register  (auth.js)    │
                         │   OAuth 2.0 AS: PKCE S256, client_creds,   │
                         │   auth_code, refresh, HMAC JWT, DCR        │
                         │           │                                │
                         │        db.js — node:sqlite (WAL)            │
                         │   users · items · recall_cache · recalls   │
                         │   · matches · remedies · oauth_*            │
                         └─────────────────┬───────────────────────────┘
                                           │
                    ┌──────────────────────┼───────────────────────┐
                    ▼                      ▼                       ▼
       saferproducts.gov (CPSC)  api.nhtsa.gov (NHTSA+vPIC)   api.fda.gov (openFDA)
```

One Node process, no build step, no Docker. Storage is a single SQLite file via the built-in
`node:sqlite` (Node ≥22.5; pinned to 22 for the build system) — no native modules, deployable to any free-tier Node host.

## Run it

```
npm install
npm start                 # PORT (default 8787), open http://localhost:8787
npm test                  # node:test — 25 tests, offline (fixtures in test/fixtures/)
```

### Environment variables (all optional, sane defaults)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `PUBLIC_URL` | `http://localhost:<port>` | Base URL used in OAuth metadata/redirects; set this to your real deploy URL |
| `DB_PATH` | `recall-radar.db` | SQLite file path (`:memory:` for ephemeral) |
| `JWT_SECRET` | random per boot | HMAC secret for access tokens — **set this in prod** or restarts invalidate all tokens |
| `ALEXA_CLIENT_ID` / `ALEXA_CLIENT_SECRET` | `alexa-plus` / `dev-secret` | Seeded confidential OAuth client for the Alexa+ MCP add-on |
| `ALLOWED_ORIGINS` | (unset) | Extra comma-separated Origins allowed on `/mcp` beyond `PUBLIC_URL` and the MCP Inspector's `localhost:6274` |
| `CACHE_TTL_HOURS` | `24` | TTL for cached CPSC/NHTSA/openFDA responses |
| `RECALL_LOOKBACK_YEARS` | `3` | How far back the CPSC bulk pull and openFDA date range go |
| `MATCH_THRESHOLD` | `0.4` | Minimum confidence `check_recalls` reports |
| `ASSEMBLYAI_API_KEY` | (unset) | Enables voice. Without it `/stt-token` returns 503 and the 🎤 button reports voice as disabled; everything else still works by typing. |
| `FDA_API_KEY` | (unset) | openFDA works keyless at a low rate limit; add a free key to raise it |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | (unset) | Optional OpenAI-compatible reranker (`match.js#rerank`) that judges the top candidates; no-op until set, heuristic score is the fallback on any error |

## Deploying

**Use Railway, Render or Fly — not Vercel.** This is a single long-lived `node:http` process, and
two things about it are incompatible with serverless:

- **MCP Streamable HTTP sessions live in memory.** `Mcp-Session-Id` maps to an open transport in a
  `Map` inside one process. On Vercel, consecutive requests can land on different instances, so the
  second request in a session gets `404 Session not found`.
- **SQLite needs a writable, persistent disk.** `node:sqlite` writes `recall-radar.db` plus WAL
  files. Vercel's filesystem is read-only apart from a per-instance `/tmp`, so the household
  inventory would be empty-or-different on every request.

Railway gives you a persistent container and a volume, which is exactly what this wants.

### Railway, start to finish

1. New Project → Deploy from GitHub repo → pick this repo. Nixpacks detects Node and runs
   `npm start`.

   **Node version is pinned to 22 on purpose, in three places that must agree** — `engines.node`
   in `package.json`, `.nvmrc` and `.node-version`. Nixpacks accepts only an explicit major
   (`22.x`, not `>=22`), reads `engines.node` *before* `.nvmrc`, and **silently falls back to
   Node 18 when it cannot parse one**. Node 18 has no `node:sqlite`, so the app would die on its
   first import with a build that otherwise looked fine. Node 22.5+ is the real floor; the suite
   is verified green on both 22 and 24.

   Developing on Node 24 is fine — `npm install` prints a cosmetic `EBADENGINE` warning because
   the pin is deliberately narrow for the build system. It does not block anything.
2. Add a **Volume** mounted at `/data`.
3. Set variables (Settings → Variables):

   | Variable | Value |
   |---|---|
   | `ASSEMBLYAI_API_KEY` | your key — required for the 🎤 button |
   | `DB_PATH` | `/data/recall-radar.db` — on the volume, so it survives restarts |
   | `JWT_SECRET` | any long random string — without it, every restart signs users out |
   | `PUBLIC_URL` | your `https://<app>.up.railway.app` URL, no trailing slash |
   | `STT_TOKENS_PER_HOUR` | optional, defaults to `60` |

4. Generate a domain (Settings → Networking), then set `PUBLIC_URL` to it and redeploy — OAuth
   metadata and redirect URIs are built from it, so it has to match the address you actually visit.
5. Check `GET /health` → `{"ok":true,"voice":true}`. `voice:false` means the key is not set.

### Optional: a Vercel front in front of it

Some hackathon rulebooks list Vercel as an accepted demo platform. `vercel.json` proxies every path to
the Railway process, which keeps the MCP sessions and the SQLite file where they must live. Import the
repo into Vercel with the **Other** preset and no build command, then set `ALLOWED_ORIGINS` on the
Railway side to the Vercel URL (e.g. `https://recall-radar-voice.vercel.app`): that whitelists the
origin for `/mcp` *and* registers it as a redirect URI for the web client's PKCE flow. Nothing runs on
Vercel; it is a door, not a second deployment.
6. Prove it end to end the way a judge's browser will hit it:
   `node scripts/live-smoke.mjs https://<app>.up.railway.app` — logs in over PKCE, runs an MCP
   handshake with the browser's `Origin`, lists tools, and mints a voice token. Fails loudly if
   `PUBLIC_URL` is wrong: without it the server advertises `http://localhost:8080`, registers the
   web client's redirect URI as localhost, and rejects every browser call to `/mcp` as a foreign
   Origin — so the page loads but nothing works.

   **If you sync variables from Doppler:** pick the *service* as the sync target, not "Shared".
   Shared goes to Railway's project-level shared variables, which a service only sees once each
   one is referenced (`${{shared.NAME}}`); the symptom is a green deploy with `voice:false` and
   the localhost issuer above.

**HTTPS is not optional for voice.** Browsers only grant microphone access on a secure origin
(`localhost` is the exception), so the mic button will not work over plain HTTP.

### Cost guard

`/stt-token` mints at most `STT_TOKENS_PER_HOUR` AssemblyAI sessions an hour across the whole
deployment, and returns `429` after that. This demo's `/authorize` page accepts any household name
by design, so a bearer token proves nothing about who you are — a per-user cap would be bypassed by
signing in twice. A global cap is the one that actually protects the bill.

## MCP endpoint contract

- **Spec:** MCP 2025-11-25, transport **Streamable HTTP**, single endpoint `POST+GET /mcp`.
- **Auth:** every request needs `Authorization: Bearer <JWT>`. Missing/invalid/expired token →
  `401` with `WWW-Authenticate: Bearer realm="recall-radar"[, error="invalid_token"], resource_metadata="<base>/.well-known/oauth-protected-resource"`.
- **Discovery:** `/.well-known/oauth-authorization-server` (grant_types_supported:
  `client_credentials`, `authorization_code`, `refresh_token`; PKCE `S256` required) and
  `/.well-known/oauth-protected-resource[/mcp]` (MCP authorization spec), so MCP Inspector /
  Claude can self-configure. `/register` supports Dynamic Client Registration (RFC 7591).
- **Sessions:** `initialize` (no `Mcp-Session-Id` header) opens a session and returns one in the
  `Mcp-Session-Id` response header; every subsequent request on that session must send it back.
  A stale/unknown session id gets `404`; a missing one on a non-initialize call gets `400`.
- **Origin check:** browser requests carrying an `Origin` header are validated against an
  allowlist (DNS-rebinding defence per the 2025-11-25 spec); non-browser clients (curl, the SDK
  client, Alexa+) that send no `Origin` skip the check.
- **Responses:** plain JSON for POST (not chunked SSE) so a normal HTTP client can read
  `res.json()` directly — target is **<500 ms** for a typical tool call (see the live
  `check_recalls` timing below: 1.6 s including an uncached upstream fetch to `saferproducts.gov`;
  once the SQLite TTL cache is warm it's low tens of ms). GET `/mcp` still opens an SSE stream for
  server-initiated notifications.
- **Tools:** `add_item`, `list_items`, `remove_item`, `import_orders`, `check_recalls`,
  `recall_details`, `start_remedy`. **Resource:** `household://inventory`. Multi-tenant: one
  household per OAuth subject (`sub` claim), enforced at the DB query layer.

### Connecting with MCP Inspector

```
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:8787/mcp
# Inspector runs on localhost:6274 by default — server.js allowlists that Origin already.
# It will discover /.well-known/oauth-authorization-server, register via /register (DCR),
# and run the authorization_code + PKCE flow through the hosted /authorize login page
# (any household name works — it's a demo login).
```

Claude / any MCP-aware client: point it at `http://localhost:8787/mcp` (or your `PUBLIC_URL`);
it will follow the same discovery → DCR → PKCE `authorization_code` → Bearer flow.

## Sample output — a real session against the live public APIs

Captured 2026-09-13 with `PORT=8790 DB_PATH=/tmp/rr-demo.db node src/server.js`, using plain
curl (no mocks — `check_recalls` below actually calls `api.fda.gov` live):

```
$ curl -s http://localhost:8790/.well-known/oauth-authorization-server
{"issuer":"http://localhost:8790","authorization_endpoint":"http://localhost:8790/authorize",
 "token_endpoint":"http://localhost:8790/token","registration_endpoint":"http://localhost:8790/register",
 "grant_types_supported":["client_credentials","authorization_code","refresh_token"],
 "response_types_supported":["code"],"code_challenge_methods_supported":["S256"],
 "token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],
 "scopes_supported":["household"]}

$ curl -s -i -X POST http://localhost:8790/mcp -H 'content-type: application/json' -d '{}'
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="recall-radar", resource_metadata="http://localhost:8790/.well-known/oauth-protected-resource"

# client_credentials grant (the Alexa+ service client seeded by ALEXA_CLIENT_ID/SECRET)
$ TOKEN=$(curl -s -X POST http://localhost:8790/token \
    -H 'content-type: application/x-www-form-urlencoded' \
    -H "authorization: Basic $(echo -n 'alexa-plus:dev-secret' | base64)" \
    -d 'grant_type=client_credentials&scope=household' | jq -r .access_token)

$ curl -s -i -X POST http://localhost:8790/mcp -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -H 'mcp-protocol-version: 2025-11-25' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl-demo","version":"0.1"}}}'
HTTP/1.1 200 OK
mcp-session-id: 342f3aa0-705b-4b94-9171-c94822bf3659
{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true}},
 "serverInfo":{"name":"recall-radar","version":"0.1.0"},
 "instructions":"Recall Radar keeps a household inventory and checks it against CPSC, NHTSA and FDA recalls. Typical flow: add_item or import_orders → check_recalls → recall_details → start_remedy."},
 "jsonrpc":"2.0","id":1}

# ...notifications/initialized (202), tools/list -> 7 tools...

$ curl -s -X POST http://localhost:8790/mcp -H "authorization: Bearer $TOKEN" \
    -H "mcp-session-id: $SID" -H 'mcp-protocol-version: 2025-11-25' -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"add_item","arguments":{"name":"Outshine Fruit Bar Watermelon 6-Count","brand":"Dreyers"}}}'
{"result":{"content":[{"type":"text","text":"Added #2: Outshine Fruit Bar Watermelon 6-Count (Dreyers) [food]"}], ...

$ time curl -s -X POST http://localhost:8790/mcp ... \
    -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"check_recalls","arguments":{"item_id":2}}}'
real  0m1.609s   # includes the live, uncached fetch to api.fda.gov
{"result":{"content":[{"type":"text","text":
 "1 possible recall across 1 item:\n- [high 85%] #2 Outshine Fruit Bar Watermelon 6-Count → Class II Food recall: Outshine Fruit Bar Watermelon, 6-Count 2.5 ounce with UPC 041548413624... (fda:H-1265-2026, 2026-08-18) — brand \"dreyers\" matches recall; 4/4 product words match (outshine, fruit, bar, watermelon)"
}], "structuredContent":{"checked":1,"matches":[{"item_id":2,"item":"Outshine Fruit Bar Watermelon 6-Count",
 "recall_id":"fda:H-1265-2026","source":"fda","confidence":0.85,"level":"high",
 "url":"https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=99716", ...}]}}, "jsonrpc":"2.0","id":6}
```

That `fda:H-1265-2026` recall is real and current: Dreyer's Grand Ice Cream Inc. recalled
Outshine Fruit Bar Watermelon on 2026-08-18 (glass-piece foreign object hazard) — Recall Radar
found it live, unprompted, from a plain product name + brand. `recall_details` and `start_remedy`
(also exercised in this session) return the hazard/remedy/contact and a 5-step remedy plan with a
14-day follow-up reminder respectively; see `test/e2e.test.js` and `test/match.test.js` for the
full assertions this transcript is backed by.

## Tests

```
npm test
```

16 tests, `node:test`, fully offline (CPSC/NHTSA/openFDA fixtures under `test/fixtures/`, saved
from real API responses): CSV parsing (classic + privacy-export "Your Orders" layouts), the
matcher (tokenisation, typo tolerance, brand/model/name scoring, category inference) against
real recall records, and a full MCP handshake over HTTP using the official SDK client
(`initialize → tools/list → add_item → import_orders → check_recalls → recall_details →
start_remedy → resources/read`) plus the OAuth AS (metadata, 401/403 behaviour, PKCE
authorization_code + refresh rotation).

## Known gaps

- **CPSC lookback window.** `check_recalls` only pulls CPSC recalls from the last
  `RECALL_LOOKBACK_YEARS` (default 3) to keep the bulk fetch small — a real, older recall (e.g.
  the 2020 Graco Pack 'n Play inclined-sleeper recall used in the matcher's test fixtures) won't
  surface from a *live* check today even though the matcher correctly scores it against the
  fixture. Widening the window trades off a slower first-pull.
- **No LLM rerank wired up yet.** `match.js#rerank` is a working hook (OpenAI-compatible
  `/chat/completions`, `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`) but nothing calls it with real
  credentials in this environment; Nebius Token Factory is the planned backend.
- **Sessions are in-memory** (one `Map` in `server.js`) — fine for one instance/one demo, not for
  horizontal scaling; would need sticky sessions or a shared session store to run >1 replica.
- **No real Alexa+ hardware test.** The Alexa+ device preview is partner-gated; this entry relies
  on the rules' documented fallback (self-hosted MCP server + simulated web client), which is
  what's demoed above.
- **openFDA/CPSC/NHTSA rate limits** are not specifically backed off/retried beyond the
  stale-if-error cache fallback in `fetchCached`.

## What's next

1. Wire `LLM_BASE_URL` to Nebius Token Factory (Nemotron) once credentials land, for a judge
   pass on ambiguous matches (`docs/knowledge/ventures/B-hackathons.md` — "Recall Radar Autopilot").
2. Demo video (2–3 min) walking through voice-style chat → CSV import → live recall hit → remedy.
3. Deploy to a free-tier Node host with a real `PUBLIC_URL`/`JWT_SECRET`, and register the
   production redirect URI with the Alexa+ MCP Toolkit.

## SKILL.md

See [`SKILL.md`](./SKILL.md) at the repo root for the Agent Skills–format instructions a coding
agent should follow to operate or extend this project.
