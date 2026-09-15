// OAuth 2.0 authorization server matching the Alexa+ MCP Toolkit contract:
// client_credentials + authorization_code (PKCE S256 required) + refresh_token, HMAC JWTs, no external deps.
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// ponytail: random secret per boot when JWT_SECRET is unset → tokens die on restart. Set JWT_SECRET in prod.
const SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const ACCESS_TTL = 3600, REFRESH_TTL = 30 * 86400, CODE_TTL = 300;
const b64u = (s) => Buffer.from(s).toString('base64url');
const rand = () => randomBytes(24).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export function signJwt(claims, ttl = ACCESS_TTL) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now(), exp: now() + ttl, ...claims }));
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** @returns {Record<string, any> | null} claims, or null if signature/expiry fail */
export function verifyJwt(token) {
  const [head, body, sig] = String(token || '').split('.');
  if (!head || !body || !sig) return null;
  const want = createHmac('sha256', SECRET).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url'));
    return claims.exp > now() ? claims : null;
  } catch { return null; }
}

export function asMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: ['household'],
  };
}

export function prMetadata(base) {
  return { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: ['household'] };
}

/** Seed the two well-known clients: the bundled web client (public/PKCE) and the Alexa+ service client (confidential). */
export function seedClients(db, base) {
  const up = db.prepare('insert or replace into oauth_clients(id, secret, redirect_uris, name) values (?,?,?,?)');
  // A front end served from another origin (e.g. a Vercel proxy in front of this server) needs its own redirect URI;
  // ALLOWED_ORIGINS already whitelists it for /mcp, so the same list drives the OAuth redirect allowlist.
  const fronts = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean).map((o) => `${o}/`);
  up.run('recall-radar-web', null, JSON.stringify([`${base}/`, ...fronts]), 'Recall Radar web client');
  up.run(process.env.ALEXA_CLIENT_ID || 'alexa-plus', process.env.ALEXA_CLIENT_SECRET || 'dev-secret', '[]', 'Alexa+ MCP add-on');
}

/** Dynamic client registration (RFC 7591) so MCP Inspector / Claude can self-register. Alexa+ uses the seeded client instead. */
export function registerClient(db, body) {
  const id = `dyn-${rand()}`;
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  const confidential = body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none';
  const secret = confidential ? rand() : null;
  db.prepare('insert into oauth_clients(id, secret, redirect_uris, name) values (?,?,?,?)').run(id, secret, JSON.stringify(uris), body.client_name || null);
  return {
    client_id: id, ...(secret && { client_secret: secret }), client_id_issued_at: now(),
    redirect_uris: uris, client_name: body.client_name, token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Validates an /authorize request. Returns an error string or null. */
export function authorizeError(db, q) {
  const c = db.prepare('select * from oauth_clients where id = ?').get(q.client_id || '');
  if (!c) return 'unknown client_id';
  if (!JSON.parse(c.redirect_uris).includes(q.redirect_uri)) return 'redirect_uri not registered for this client';
  if (q.response_type !== 'code') return 'response_type must be code';
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) return 'PKCE S256 code_challenge required';
  return null;
}

/** Demo hosted login/consent page: username only. */
export function loginPage(q, error) {
  const hidden = ['client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'response_type', 'resource']
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Recall Radar</title>
<style>body{font:16px system-ui;background:#0f1419;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;width:320px}h1{font-size:20px;margin:0 0 6px}p{color:#8b949e;margin:0 0 18px;font-size:14px}
input[type=text]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;margin-bottom:14px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font-weight:600;cursor:pointer}.err{color:#f85149}</style>
<form method="post" action="/authorize"><h1>Recall Radar</h1><p><b>${esc(q.client_id)}</b> wants to read and update your household inventory and recall checks.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}${hidden}
<label>Household name<br><input type="text" name="username" placeholder="e.g. smith-family" required autofocus></label>
<button type="submit">Sign in &amp; allow</button></form>`;
}

/** Issues an authorization code after the consent form is posted. Returns the redirect URL. */
export function issueCode(db, q) {
  const code = rand();
  const sub = String(q.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').slice(0, 64) || 'demo';
  db.prepare('insert into oauth_codes(code, client_id, redirect_uri, challenge, sub, scope, expires) values (?,?,?,?,?,?,?)')
    .run(code, q.client_id, q.redirect_uri, q.code_challenge, sub, q.scope || 'household', now() + CODE_TTL);
  const u = new URL(q.redirect_uri);
  u.searchParams.set('code', code);
  if (q.state) u.searchParams.set('state', q.state);
  return u.href;
}

function clientAuth(db, form, authHeader) {
  let id = form.client_id, secret = form.client_secret;
  if (authHeader?.startsWith('Basic ')) [id, secret] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
  const c = db.prepare('select * from oauth_clients where id = ?').get(id || '');
  if (!c) return { error: 'invalid_client' };
  if (c.secret && c.secret !== secret) return { error: 'invalid_client' };
  return { client: c };
}

function tokens(db, base, client, sub, scope, withRefresh) {
  db.prepare('insert or ignore into users(id) values (?)').run(sub);
  const out = { access_token: signJwt({ iss: base, aud: `${base}/mcp`, sub, client_id: client.id, scope }), token_type: 'Bearer', expires_in: ACCESS_TTL, scope };
  if (withRefresh) {
    out.refresh_token = rand();
    db.prepare('insert into oauth_refresh(token, client_id, sub, scope, expires) values (?,?,?,?,?)').run(out.refresh_token, client.id, sub, scope, now() + REFRESH_TTL);
  }
  return out;
}

/** Token endpoint. @returns {{status:number, body:object}} */
export function tokenGrant(db, base, form, authHeader) {
  const bad = (error, error_description) => ({ status: 400, body: { error, error_description } });
  const { client, error } = clientAuth(db, form, authHeader);
  if (error) return { status: 401, body: { error } };
  switch (form.grant_type) {
    case 'client_credentials': {
      if (!client.secret) return bad('unauthorized_client', 'public clients cannot use client_credentials');
      return { status: 200, body: tokens(db, base, client, client.id, form.scope || 'household', false) };
    }
    case 'authorization_code': {
      const row = db.prepare('select * from oauth_codes where code = ?').get(form.code || '');
      if (row) db.prepare('delete from oauth_codes where code = ?').run(form.code); // single use
      if (!row || row.expires < now() || row.client_id !== client.id) return bad('invalid_grant', 'code unknown, expired or wrong client');
      if (row.redirect_uri !== form.redirect_uri) return bad('invalid_grant', 'redirect_uri mismatch');
      const challenge = createHash('sha256').update(form.code_verifier || '').digest('base64url');
      if (challenge !== row.challenge) return bad('invalid_grant', 'PKCE verification failed');
      return { status: 200, body: tokens(db, base, client, row.sub, row.scope, true) };
    }
    case 'refresh_token': {
      const row = db.prepare('select * from oauth_refresh where token = ?').get(form.refresh_token || '');
      if (row) db.prepare('delete from oauth_refresh where token = ?').run(form.refresh_token); // rotate
      if (!row || row.expires < now() || row.client_id !== client.id) return bad('invalid_grant', 'refresh token unknown, expired or wrong client');
      return { status: 200, body: tokens(db, base, client, row.sub, row.scope, true) };
    }
    default: return bad('unsupported_grant_type', 'use client_credentials, authorization_code or refresh_token');
  }
}
