---
name: recall-radar
description: Operate or extend Recall Radar — an MCP server (spec 2025-11-25, Streamable HTTP) that checks a household inventory against CPSC/NHTSA/openFDA recall data, with its own OAuth 2.0 AS and a simulated-Alexa+ web client. Use this skill when running, testing, debugging, or adding features to the recall-radar repo.
---

# Recall Radar

One Node process (`src/server.js`), no build step, no Docker, ≤2 runtime deps
(`@modelcontextprotocol/sdk`, `zod`). Storage is one SQLite file via built-in `node:sqlite`.

## Layout

```
src/
  server.js   node:http entry point — routes /mcp, /.well-known/*, /authorize, /token,
              /register, / (web client). Reads env vars (PORT, PUBLIC_URL, DB_PATH, ...).
  mcp.js      MCP tools/resource definitions (add_item, list_items, remove_item,
              import_orders, check_recalls, recall_details, start_remedy;
              resource household://inventory). One McpServer instance per session,
              closed over the OAuth subject.
  auth.js     OAuth 2.0 AS: PKCE S256, client_credentials/authorization_code/refresh_token,
              HMAC JWTs (node:crypto, no external deps), Dynamic Client Registration.
  db.js       node:sqlite schema (users, items, recall_cache, recalls, matches, remedies,
              oauth_*). No migrations — edit the `create table if not exists` block in place.
  recalls.js  CPSC/NHTSA(+vPIC)/openFDA connectors, response normalisation to one shared
              shape, SQLite TTL cache (recall_cache table + an in-process memo Map).
  orders.js   Amazon "Your Orders" CSV parser (classic + privacy-export layouts).
  match.js    tokenise/normalise, dice-bigram fuzzy match, explainable confidence scoring,
              category inference, optional LLM rerank hook (OpenAI-compatible, env-gated).
public/index.html   static web client: OAuth PKCE in the browser, rule-based intent router,
                    renders MCP tool results as recall cards. No LLM, no build step.
test/               node:test suite + test/fixtures/*.json (real captured API responses).
```

## Running it

```
npm install
npm start                              # http://localhost:8787 (or $PORT)
npm test                               # 16 tests, fully offline
node --disable-warning=ExperimentalWarning --test 'test/**/*.test.js'   # same, without npm
```

Key env vars (all optional): `PORT`, `PUBLIC_URL`, `DB_PATH`, `JWT_SECRET`, `ALEXA_CLIENT_ID`/
`ALEXA_CLIENT_SECRET`, `ALLOWED_ORIGINS`, `CACHE_TTL_HOURS`, `RECALL_LOOKBACK_YEARS`,
`MATCH_THRESHOLD`, `FDA_API_KEY`, `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`. See README.md for
what each does and why the defaults are what they are.

## Ground rules for changes here (ponytail)

- **Smallest change that fixes the real cause.** Find the actual bug (regex boundary, wrong
  stopword, off-by-one) before touching a test. Never loosen a test to make a bug disappear.
- **stdlib first.** `node:sqlite`, `node:crypto`, `node:http`, `node:test` are already load-
  bearing here specifically to keep deps at 2. Don't add a dependency for something Node already
  does (HTTP framework, ORM, JWT library, CSV library, test runner).
- **One runnable check per non-trivial change.** After any edit, run `npm test` and, if you
  touched `server.js`/`mcp.js`/`auth.js`, also do a live smoke test:
  ```
  PORT=8790 DB_PATH=/tmp/rr-smoke.db node --disable-warning=ExperimentalWarning src/server.js &
  curl -s http://localhost:8790/.well-known/oauth-authorization-server
  # ...then a client_credentials token + initialize, see README.md's transcript for the exact
  # sequence... then kill the process and rm /tmp/rr-smoke.db*
  ```
- **Fixtures are real captured API data**, not hand-written. If a fixture needs updating, re-pull
  it from the live endpoint (`recalls.js` exports `cpscUrl`/`nhtsaUrl`/`fdaUrl` — reuse them, don't
  hand-roll a new URL) and re-check every assertion that depends on it still holds; don't just
  patch the JSON to make a test pass.
- **Multi-tenancy is per OAuth subject** (`sub` claim → `items.user_id`/`matches.user_id`/
  `remedies.user_id`). Any new tool or query must filter by it — there's no other tenant boundary.
- **`node --test test/` (bare directory) does not work on Node 24 in this environment** — it
  throws `MODULE_NOT_FOUND` instead of globbing. Always invoke with an explicit glob:
  `--test 'test/**/*.test.js'` (this is what `npm test` does — don't revert it back to the bare
  directory form).

## Extending it

- **New recall source:** add a `normalize<Source>()` in `recalls.js` returning the shared shape
  (`{id, source, title, brand, products:[{name,model}], description, hazard, remedy, contact,
  url, date, image}`), wire it into `candidatesFor()`'s category routing, add a fixture under
  `test/fixtures/` captured from the real endpoint, and a `match.test.js` case.
- **New MCP tool:** register it in `mcp.js` with a zod `inputSchema`, keep responses in the
  `{content:[{type:'text',text}], structuredContent}` shape the web client and tests expect,
  and add an `e2e.test.js` call if it changes the tools/list surface.
- **New CSV layout in `orders.js`:** add a header regex to the `col()` lookups in `parseOrders`;
  don't special-case the layout elsewhere — category/brand inference is layout-agnostic already.
- **Turning on the LLM reranker:** set `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` to an
  OpenAI-compatible endpoint (Nebius Token Factory is the intended one); `match.js#rerank` is
  already wired into `check_recalls` in `mcp.js` and no-ops safely without those vars.
