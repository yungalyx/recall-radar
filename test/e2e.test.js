// End-to-end over HTTP: OAuth (client_credentials + PKCE code flow + refresh), bearer/Origin enforcement, and a full
// MCP handshake with the official SDK client. Upstream recall APIs are replaced by seeding the SQLite cache with real fixtures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start } from '../src/server.js';
import { cpscUrl, nhtsaUrl } from '../src/recalls.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
let s, base, serviceToken;
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const mcpPost = (body, headers = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers }, body: JSON.stringify(body) });
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

before(async () => {
  s = await start({ port: 0, dbPath: ':memory:' });
  base = s.base;
  const seed = s.db.prepare('insert into recall_cache(url, body, fetched_at) values (?,?,?)');
  seed.run(cpscUrl(), fixture('cpsc_graco.json'), Date.now());
  seed.run(nhtsaUrl('Honda', 'Civic', '2020'), fixture('nhtsa_civic_2020.json'), Date.now());
  const r = await fetch(`${base}/token`, { ...form({ grant_type: 'client_credentials' }), headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('alexa-plus:dev-secret').toString('base64') } });
  serviceToken = (await r.json()).access_token;
  assert.ok(serviceToken, 'client_credentials token issued');
});
after(() => s.close());

test('metadata: AS lists the Alexa+ grant types and PKCE S256; protected-resource points at /mcp', async () => {
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.grant_types_supported, ['client_credentials', 'authorization_code', 'refresh_token']);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(pr.resource, `${base}/mcp`);
  assert.deepEqual(pr.authorization_servers, [base]);
});

test('/mcp without or with a bad bearer → 401 + WWW-Authenticate with resource_metadata', async () => {
  const r = await mcpPost(INIT);
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer realm="recall-radar", resource_metadata=".*oauth-protected-resource"$/);
  const bad = await mcpPost(INIT, { authorization: 'Bearer nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
});

test('/mcp rejects a foreign Origin (DNS rebinding) with 403', async () => {
  const r = await mcpPost(INIT, { authorization: `Bearer ${serviceToken}`, origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('authorization_code + PKCE S256 → tokens; wrong verifier rejected; refresh rotates', async () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = { response_type: 'code', client_id: 'recall-radar-web', redirect_uri: `${base}/`, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'household' };
  const page = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/authorize"/);
  const noPkce = await fetch(`${base}/authorize?${new URLSearchParams({ ...q, code_challenge_method: 'plain' })}`);
  assert.equal(noPkce.status, 400);

  const consent = await fetch(`${base}/authorize`, { ...form({ ...q, username: 'Smith Family' }), redirect: 'manual' });
  assert.equal(consent.status, 302);
  const loc = new URL(consent.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const wrong = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', client_id: 'recall-radar-web', code, redirect_uri: `${base}/`, code_verifier: 'wrong' }));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'invalid_grant');
  // the code was consumed by the failed attempt (single use) → get a fresh one
  const consent2 = await fetch(`${base}/authorize`, { ...form({ ...q, username: 'Smith Family' }), redirect: 'manual' });
  const code2 = new URL(consent2.headers.get('location')).searchParams.get('code');
  const tok = await (await fetch(`${base}/token`, form({ grant_type: 'authorization_code', client_id: 'recall-radar-web', code: code2, redirect_uri: `${base}/`, code_verifier: verifier }))).json();
  assert.ok(tok.access_token && tok.refresh_token);
  assert.equal(tok.token_type, 'Bearer');

  const re = await (await fetch(`${base}/token`, form({ grant_type: 'refresh_token', client_id: 'recall-radar-web', refresh_token: tok.refresh_token }))).json();
  assert.ok(re.access_token && re.refresh_token !== tok.refresh_token, 'refresh token rotated');
  const reused = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', client_id: 'recall-radar-web', refresh_token: tok.refresh_token }));
  assert.equal(reused.status, 400, 'old refresh token is dead');

  // multi-tenant: the PKCE user's session is not usable with the service client's token
  const init = await mcpPost(INIT, { authorization: `Bearer ${re.access_token}` });
  const sid = init.headers.get('mcp-session-id');
  assert.ok(sid);
  const cross = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${serviceToken}`, 'mcp-session-id': sid });
  assert.equal(cross.status, 403);
});

test('MCP over Streamable HTTP with the SDK client: initialize → tools/list → add_item → check_recalls → details → remedy → resource', async () => {
  const client = new Client({ name: 'e2e', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${serviceToken}` } } });
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'recall-radar');
  assert.ok(transport.sessionId, 'server assigned an Mcp-Session-Id');

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add_item', 'check_recalls', 'import_orders', 'list_items', 'recall_details', 'remove_item', 'start_remedy']);

  const added = await client.callTool({ name: 'add_item', arguments: { name: 'Little Lounger rocking seat', brand: 'Graco' } });
  assert.equal(added.structuredContent.item.category, 'product');
  const car = await client.callTool({ name: 'add_item', arguments: { name: '2020 Honda Civic', brand: 'Honda', model: 'Civic' } });
  assert.equal(car.structuredContent.item.category, 'vehicle');

  const imp = await client.callTool({ name: 'import_orders', arguments: { csv_text: fixture('orders.csv') } });
  assert.equal(imp.structuredContent.imported, 3);

  const check = await client.callTool({ name: 'check_recalls', arguments: {} });
  const { matches, checked } = check.structuredContent;
  assert.equal(checked, 5);
  const graco = matches.find((m) => m.recall_id === 'cpsc:20062');
  assert.ok(graco && graco.level === 'high', 'Graco Little Lounger matched from the seeded CPSC data');
  assert.equal(matches.filter((m) => m.source === 'nhtsa').length, 5, 'all five 2020 Civic campaigns matched');
  assert.match(check.content[0].text, /possible recalls across 5 items/);

  const details = await client.callTool({ name: 'recall_details', arguments: { recall_id: 'cpsc:20062' } });
  assert.match(details.structuredContent.recall.contact, /800-345-4109/);

  const remedy = await client.callTool({ name: 'start_remedy', arguments: { recall_id: 'cpsc:20062', item_id: added.structuredContent.item.id } });
  assert.equal(remedy.structuredContent.path, 'refund');
  assert.equal(remedy.structuredContent.steps.length, 5);
  assert.equal(s.db.prepare('select count(*) n from remedies').get().n, 1);

  const inv = await client.readResource({ uri: 'household://inventory' });
  assert.equal(JSON.parse(inv.contents[0].text).items.length, 5);

  const missing = await client.callTool({ name: 'recall_details', arguments: { recall_id: 'cpsc:nope' } });
  assert.equal(missing.isError, true);
  await client.close();
});

// --- voice: the browser must never see the AssemblyAI key, and minting must cost an attacker a token ---
test('/stt-token requires a bearer token and mints a short-lived AssemblyAI token', async () => {
  const anon = await fetch(`${base}/stt-token`);
  assert.equal(anon.status, process.env.ASSEMBLYAI_API_KEY ? 401 : 503);

  if (!process.env.ASSEMBLYAI_API_KEY) return; // offline/no-key runs still assert the gate above
  const r = await fetch(`${base}/stt-token`, { headers: { authorization: `Bearer ${serviceToken}` } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.token?.length > 100, 'a real streaming token came back');
  assert.ok(body.expires_in_seconds > 0 && body.expires_in_seconds <= 600);
  assert.ok(!JSON.stringify(body).includes(process.env.ASSEMBLYAI_API_KEY), 'the API key is not in the response');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

// A public demo lets anyone sign in under any household name, so the only cap that protects the
// AssemblyAI bill is the global one. Verify it actually closes.
test('/stt-token stops minting once the hourly cap is reached', async () => {
  if (!process.env.ASSEMBLYAI_API_KEY) return; // the cap only engages on the live mint path
  const limited = await start({ port: 0, dbPath: ':memory:' });
  try {
    const auth = { authorization: `Bearer ${(await (await fetch(`${limited.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('alexa-plus:dev-secret').toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    })).json()).access_token}` };
    const codes = [];
    for (let i = 0; i < Number(process.env.STT_TOKENS_PER_HOUR) + 1; i++) {
      codes.push((await fetch(`${limited.base}/stt-token`, { headers: auth })).status);
    }
    assert.equal(codes.at(-1), 429, 'the request past the cap is refused');
    assert.ok(codes.slice(0, -1).every((c) => c === 200), 'everything up to the cap succeeds');
  } finally { await limited.close(); }
});
