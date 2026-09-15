#!/usr/bin/env node
// Prove a deployment works the way a judge's browser will use it: PKCE login as a household, then an MCP
// handshake + tools/list with the browser's own Origin header, then /health for voice. Run:
//   node scripts/live-smoke.mjs https://your-app.example.com
// Exits non-zero on the first failure. Sends Origin on purpose: curl without it passes checks the browser fails.
import { createHash, randomBytes } from 'node:crypto';

const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/live-smoke.mjs <public-url>'); process.exit(2); }
const fail = (m) => { console.error('FAIL', m); process.exit(1); };
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

const health = await (await fetch(`${base}/health`)).json();
console.log('health', health);
const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
console.log('issuer', as.issuer);
if (as.issuer !== base) fail(`issuer is ${as.issuer}; PUBLIC_URL is not set to ${base}`);

const verifier = randomBytes(32).toString('base64url');
const q = { response_type: 'code', client_id: 'recall-radar-web', redirect_uri: `${base}/`, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's', scope: 'household' };
const consent = await fetch(`${base}/authorize`, { ...form({ ...q, username: 'Smoke Household' }), redirect: 'manual' });
if (consent.status !== 302) fail(`/authorize returned ${consent.status}: ${(await consent.text()).slice(0, 200)}`);
const code = new URL(consent.headers.get('location')).searchParams.get('code');
const tok = await (await fetch(`${base}/token`, form({ grant_type: 'authorization_code', client_id: 'recall-radar-web', code, redirect_uri: `${base}/`, code_verifier: verifier }))).json();
if (!tok.access_token) fail(`/token: ${JSON.stringify(tok)}`);
console.log('login ok');

const mcp = (body, extra = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { origin: base, authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...extra }, body: JSON.stringify(body) });
const init = await mcp({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-smoke', version: '0' } } });
if (init.status !== 200) fail(`/mcp initialize with browser Origin returned ${init.status}: ${(await init.text()).slice(0, 200)}`);
const sid = init.headers.get('mcp-session-id');
// Streamable HTTP lets the server answer a POST as plain JSON or as an SSE stream; accept both.
const body = (t) => JSON.parse(t.trimStart().startsWith('{') ? t : t.split('\n').find((l) => l.startsWith('data:')).slice(5));
console.log('mcp initialize ok, server', body(await init.text()).result?.serverInfo);
await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid });
const tools = body(await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': sid })).text());
console.log('tools', tools.result.tools.map((t) => t.name));
await fetch(`${base}/mcp`, { method: 'DELETE', headers: { origin: base, authorization: `Bearer ${tok.access_token}`, 'mcp-session-id': sid } }); // leave no session behind
const stt = await fetch(`${base}/stt-token`, { headers: { authorization: `Bearer ${tok.access_token}` } });
console.log('stt-token', stt.status, stt.status === 200 ? 'voice live' : (await stt.json()).error);
if (!health.voice) fail('voice is off: ASSEMBLYAI_API_KEY is not reaching the process');
console.log('OK');
