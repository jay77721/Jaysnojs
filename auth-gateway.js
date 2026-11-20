const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PUBLIC_PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_PORT || 3021);
const CORE_PORT = Number(process.env.ARGO_PORT || 8001);
const SUB_PATH = String(process.env.SUB_PATH || 'sub').replace(/^\/+/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const INNER_HOST = '127.0.0.1';
const APP_VERSION = process.env.APP_VERSION || 'dev';
const FILE_PATH = process.env.FILE_PATH || './tmp';

// watchdogs
const CORE_CHECK_INTERVAL = Number(process.env.CORE_CHECK_INTERVAL || 30000);
const CORE_FAIL_LIMIT = Number(process.env.CORE_FAIL_LIMIT || 3);
const CORE_GRACE_MS = Number(process.env.CORE_GRACE_MS || 180000);
const CHILD_RESTART_LIMIT = Number(process.env.CHILD_RESTART_LIMIT || 2);
const TUNNEL_FAIL_LIMIT = Number(process.env.TUNNEL_FAIL_LIMIT || 3);
const TUNNEL_TIMEOUT = Number(process.env.TUNNEL_TIMEOUT || 10000);

// subscription protections
const RATE_LIMIT = Number(process.env.SUB_RATE_LIMIT || 30); // per minute per IP, 0 = off
const TOKEN_TTL = Number(process.env.SUB_TOKEN_TTL || 0); // seconds, 0 = plain token

const startedAt = Date.now();
const state = { core: null, tunnel: null, host: null, childRestarts: 0, lastError: '' };

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseUrl(url) {
  try {
    return new URL(String(url || '/').replace(/^\/+/, '/'), 'http://localhost');
  } catch {
    return null;
  }
}

function normalizePath(pathname) {
  let value = String(pathname || '/');
  try {
    value = decodeURIComponent(value);
  } catch {}
  value = value.replace(/\/+/g, '/');
  try {
    value = new URL(value, 'http://localhost').pathname;
  } catch {}
  return (value.replace(/\/+$/, '').toLowerCase()) || '/';
}

function isSubscription(url) {
  const parsed = parseUrl(url);
  return parsed !== null && normalizePath(parsed.pathname) === normalizePath(`/${SUB_PATH}`);
}

function getToken(req, parsed) {
  const authorization = req.headers.authorization || '';
  const bearer = /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '') : '';
  return parsed.searchParams.get('token') || req.headers['x-auth-token'] || bearer || '';
}

// Signed tokens keep a leaked URL from working forever: <token>.<expUnix>.<hmac>
function signExpiry(exp) {
  const mac = crypto.createHmac('sha256', AUTH_TOKEN).update(`${AUTH_TOKEN}.${exp}`).digest('base64url');
  return `${AUTH_TOKEN}.${exp}.${mac}`;
}

function tokenValid(candidate) {
  if (!AUTH_TOKEN) return true;
  if (!TOKEN_TTL) return safeEqual(candidate, AUTH_TOKEN);
  const parts = String(candidate).split('.');
  if (parts.length !== 3) return false;
  const [token, exp, mac] = parts;
  if (!safeEqual(token, AUTH_TOKEN)) return false;
  const expected = crypto.createHmac('sha256', AUTH_TOKEN).update(`${token}.${exp}`).digest('base64url');
  if (!safeEqual(mac, expected)) return false;
  return Number(exp) > Math.floor(Date.now() / 1000);
}

// per-IP fixed-window limiter for the subscription endpoint only
const hits = new Map();
function rateLimited(ip) {
  if (!RATE_LIMIT) return false;
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > 60000) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start > 120000) hits.delete(ip);
}, 60000).unref();

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const parsed = parseUrl(url) || new URL('http://localhost/');
  const route = normalizePath(parsed.pathname);

  if (route === '/healthz') {
    const ok = state.core === true && state.tunnel === true;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok,
      core: state.core,
      tunnel: state.tunnel,
      host: state.host,
      version: APP_VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      innerPort: INNER_PORT,
      lastError: state.lastError || undefined,
    }));
    return;
  }

  if (route === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: APP_VERSION }));
    return;
  }

  if (isSubscription(url)) {
    res.setHeader('Cache-Control', 'no-store');
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (rateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too Many Requests');
      return;
    }
    if (!tokenValid(getToken(req, parsed))) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return;
    }
  }

  const headers = { ...req.headers, host: `${INNER_HOST}:${INNER_PORT}` };
  const proxyReq = http.request({
    hostname: INNER_HOST,
    port: INNER_PORT,
    path: url,
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    // never log the raw url: it can carry ?token=
    console.error(`proxy error on ${route}: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
});

if (INNER_PORT >= 3001 && INNER_PORT <= 3004) {
  console.error(`INNER_PORT=${INNER_PORT} collides with the proxy core (3001-3004); the core will not start`);
}
if (INNER_PORT === PUBLIC_PORT) {
  console.error(`INNER_PORT and PORT are both ${PUBLIC_PORT}; the gateway cannot listen`);
}

server.listen(PUBLIC_PORT, () => {
  console.log(`auth gateway listening on :${PUBLIC_PORT} -> :${INNER_PORT} (version ${APP_VERSION})`);
  if (!AUTH_TOKEN) console.log('AUTH_TOKEN is empty, subscription is public');
  else if (TOKEN_TTL) console.log(`subscription tokens expire after ${TOKEN_TTL}s; current: ${signExpiry(Math.floor(Date.now() / 1000) + TOKEN_TTL)}`);
});

function coreAlive() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: CORE_PORT });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(3000, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

// The tunnel host is what clients actually connect to: a raw ip/域名 that
// cloudflared registered. It dies silently while the core keeps listening, so
// probe it and let the container restart (restart policy) when it is gone.
function tunnelHost() {
  try {
    const raw = fs.readFileSync(path.join(FILE_PATH, 'sub.txt'), 'utf8').trim();
    // index.js writes the subscription base64-encoded; decode only if needed
    const text = raw.includes('trycloudflare.com') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const match = text.match(/[a-z0-9-]+\.trycloudflare\.com/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

function tunnelAlive(host) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const req = https.request({
      host,
      port: 443,
      path: '/vless-argo',
      method: 'GET',
      servername: host,
      timeout: TUNNEL_TIMEOUT,
      headers: { Host: host },
    }, (res) => {
      res.resume();
      // 530/522/523/524: edge up, no connector behind it
      resolve(![522, 523, 524, 530].includes(res.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

let child;
if (process.env.SKIP_INNER !== '1') {
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env: { ...process.env, SERVER_PORT: String(INNER_PORT) },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    console.error(`inner app exited (code=${code}, signal=${signal})`);
    server.close(() => process.exit(code === null ? 1 : code));
  });

  if (process.env.WATCHDOG !== '0') {
    let coreFail = 0;
    let tunnelFail = 0;
    let bootFail = 0;

    const timer = setInterval(async () => {
      if (Date.now() - startedAt < CORE_GRACE_MS) return;

      state.core = await coreAlive();
      state.host = tunnelHost();
      state.tunnel = await tunnelAlive(state.host);

      if (!state.core) {
        coreFail += 1;
        console.error(`proxy core on :${CORE_PORT} is not listening (${coreFail}/${CORE_FAIL_LIMIT})`);
        if (coreFail >= CORE_FAIL_LIMIT) {
          coreFail = 0;
          if (state.childRestarts >= CHILD_RESTART_LIMIT) {
            state.lastError = 'core never came up';
            console.error('core did not come up after retries; restarting the container');
            process.exit(1);
          }
          state.childRestarts += 1;
          console.error(`restarting the inner app to recover the core (attempt ${state.childRestarts})`);
          child.kill('SIGTERM');
        }
        return;
      }
      coreFail = 0;

      if (!state.host) {
        // no host at all means the inner app never published a subscription
        bootFail += 1;
        console.error(`no tunnel host in ${FILE_PATH}/sub.txt (${bootFail}/${CORE_FAIL_LIMIT})`);
        if (bootFail >= CORE_FAIL_LIMIT) {
          bootFail = 0;
          if (state.childRestarts >= CHILD_RESTART_LIMIT) {
            state.lastError = 'no subscription after retries';
            console.error('inner app never produced a subscription; restarting the container');
            process.exit(1);
          }
          state.childRestarts += 1;
          console.error(`restarting the inner app (attempt ${state.childRestarts})`);
          child.kill('SIGTERM');
        }
        return;
      }
      bootFail = 0;

      if (!state.tunnel) {
        tunnelFail += 1;
        console.error(`tunnel ${state.host || '(no host)'} is not answering (${tunnelFail}/${TUNNEL_FAIL_LIMIT})`);
        if (tunnelFail >= TUNNEL_FAIL_LIMIT) {
          state.lastError = 'tunnel unreachable';
          console.error('tunnel is gone; restarting the container for a fresh one');
          process.exit(1);
        }
        return;
      }
      if (tunnelFail) console.log(`tunnel ${state.host} is answering again`);
      tunnelFail = 0;
    }, CORE_CHECK_INTERVAL);
    timer.unref();
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (child) child.kill(signal);
    server.close(() => process.exit(0));
  });
}
