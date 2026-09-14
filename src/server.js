// One node:http process: static web client, OAuth 2.0 AS, and the MCP Streamable HTTP endpoint at /mcp.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb } from './db.js';
import { asMetadata, prMetadata, seedClients, registerClient, authorizeError, loginPage, issueCode, tokenGrant, verifyJwt } from './auth.js';
import { createMcpServer } from './mcp.js';

const PAGE = readFileSync(new URL('../public/index.html', import.meta.url));
const INTENT = readFileSync(new URL('./intent.js', import.meta.url));
const MAX_BODY = 8 * 1024 * 1024; // Amazon order exports can be a few MB
const STT_TOKEN_TTL = 300; // seconds; AssemblyAI allows 1-600. Long enough for one conversation.
// This is a public demo whose /authorize page accepts any household name, so a bearer token is
// not a meaningful identity and a per-user cap would be trivially bypassed. The cap that actually
// protects the AssemblyAI bill is a global one.
const STT_TOKENS_PER_HOUR = Number(process.env.STT_TOKENS_PER_HOUR) || 60;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
const parseForm = (s) => Object.fromEntries(new URLSearchParams(s));
const send = (res, status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };
const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json', ...headers });

export async function start({ port = Number(process.env.PORT) || 8787, dbPath } = {}) {
  const db = openDb(dbPath);
  const sessions = new Map(); // ponytail: in-memory sessions → one instance; move to sticky sessions or stateless mode when scaling out
  const sttMints = []; // timestamps of AssemblyAI token mints, for the hourly cap above
  let base;
  const allowedOrigins = () => new Set([base, 'http://localhost:6274', 'http://127.0.0.1:6274', ...(process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean)]);

  const cors = (req, res) => {
    const o = req.headers.origin;
    if (o && allowedOrigins().has(o)) {
      res.setHeader('access-control-allow-origin', o);
      res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version, www-authenticate');
    }
  };
  const unauthorized = (res, why) => json(res, 401, { error: 'invalid_token', error_description: why }, {
    'www-authenticate': `Bearer realm="recall-radar"${why === 'missing bearer token' ? '' : ', error="invalid_token"'}, resource_metadata="${base}/.well-known/oauth-protected-resource"`,
  });

  async function mcp(req, res) {
    // MCP spec 2025-11-25: validate Origin on every request (DNS-rebinding defence); browsers always send it, curl/Claude don't.
    if (req.headers.origin && !allowedOrigins().has(req.headers.origin)) return json(res, 403, { error: 'forbidden origin' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return unauthorized(res, 'missing bearer token');
    const claims = verifyJwt(auth.slice(7));
    if (!claims) return unauthorized(res, 'token invalid or expired');
    req.auth = { token: auth.slice(7), clientId: claims.client_id, scopes: String(claims.scope || '').split(' '), extra: { sub: claims.sub } };
    db.prepare('insert or ignore into users(id) values (?)').run(claims.sub);

    const sid = req.headers['mcp-session-id'];
    const body = req.method === 'POST' ? JSON.parse(await readBody(req) || 'null') : undefined;
    const isInit = body && !Array.isArray(body) ? body.method === 'initialize' : Array.isArray(body) && body.some((m) => m.method === 'initialize');
    const t0 = performance.now();
    res.on('finish', () => console.log(`${req.method} /mcp ${body?.method || ''} ${body?.params?.name || ''} ${res.statusCode} ${Math.round(performance.now() - t0)}ms`));

    if (!sid && isInit) {
      const server = createMcpServer(db, claims.sub);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true, // plain JSON for POST responses (<500 ms target, curl-friendly); GET /mcp still opens an SSE stream
        onsessioninitialized: (id) => sessions.set(id, { transport, sub: claims.sub }),
        onsessionclosed: (id) => sessions.delete(id),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }
    const s = sid && sessions.get(sid);
    if (!s) return json(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Session not found; send initialize again' : 'Mcp-Session-Id header required' }, id: null });
    if (s.sub !== claims.sub) return json(res, 403, { error: 'session belongs to another user' });
    return s.transport.handleRequest(req, res, body);
  }

  // Mint a short-lived AssemblyAI streaming token. The browser opens the mic WebSocket itself --
  // audio never transits this server -- but it must never see our API key, and minting spends our
  // credit, so this is behind the same bearer token as /mcp.
  async function sttToken(req, res) {
    const key = process.env.ASSEMBLYAI_API_KEY;
    if (!key) return json(res, 503, { error: 'voice_disabled', error_description: 'ASSEMBLYAI_API_KEY is not set' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !verifyJwt(auth.slice(7))) return unauthorized(res, 'missing bearer token');

    const now = Date.now();
    while (sttMints.length && now - sttMints[0] > 3600_000) sttMints.shift();
    if (sttMints.length >= STT_TOKENS_PER_HOUR) {
      return json(res, 429, { error: 'rate_limited', error_description: `This demo mints at most ${STT_TOKENS_PER_HOUR} voice sessions an hour. Try again shortly, or type instead.` }, { 'retry-after': '600' });
    }
    sttMints.push(now);

    const r = await fetch(`https://streaming.assemblyai.com/v3/token?expires_in_seconds=${STT_TOKEN_TTL}`, { headers: { authorization: key } });
    if (!r.ok) return json(res, 502, { error: 'stt_token_failed', error_description: await r.text() });
    return json(res, 200, await r.json(), { 'cache-control': 'no-store' });
  }

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    try {
      cors(req, res);
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (p === '/mcp') return await mcp(req, res);
      if (p === '/.well-known/oauth-authorization-server') return json(res, 200, asMetadata(base));
      if (p.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, prMetadata(base));
      if (p === '/register' && req.method === 'POST') return json(res, 201, registerClient(db, JSON.parse(await readBody(req) || '{}')));
      if (p === '/token' && req.method === 'POST') { const { status, body } = tokenGrant(db, base, parseForm(await readBody(req)), req.headers.authorization); return json(res, status, body, { 'cache-control': 'no-store' }); }
      if (p === '/authorize') {
        const q = req.method === 'POST' ? parseForm(await readBody(req)) : Object.fromEntries(url.searchParams);
        const err = authorizeError(db, q);
        if (err) return send(res, 400, loginPage(q, err), { 'content-type': 'text/html' });
        if (req.method === 'POST' && q.username) return send(res, 302, '', { location: issueCode(db, q) });
        return send(res, 200, loginPage(q), { 'content-type': 'text/html' });
      }
      if (p === '/' || p === '/index.html') return send(res, 200, PAGE, { 'content-type': 'text/html; charset=utf-8' });
      // The intent router is shared: the page imports this exact file that `node --test` tests.
      if (p === '/intent.js') return send(res, 200, INTENT, { 'content-type': 'text/javascript; charset=utf-8' });
      if (p === '/stt-token') return await sttToken(req, res);
      if (p === '/health') return json(res, 200, { ok: true, sessions: sessions.size, voice: Boolean(process.env.ASSEMBLYAI_API_KEY) });
      json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error(req.method, p, e);
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  });
  await new Promise((r) => httpServer.listen(port, r));
  base = (process.env.PUBLIC_URL || `http://localhost:${httpServer.address().port}`).replace(/\/$/, '');
  seedClients(db, base);
  console.log(`Recall Radar on ${base}  (MCP: ${base}/mcp, AS metadata: ${base}/.well-known/oauth-authorization-server)`);
  return { db, base, httpServer, close: () => new Promise((r) => { for (const s of sessions.values()) s.transport.close(); httpServer.close(r); db.close(); }) };
}

if (process.argv[1] === import.meta.filename) start();
