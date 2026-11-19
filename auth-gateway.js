const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PUBLIC_PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_PORT || 3021);
const CORE_PORT = Number(process.env.ARGO_PORT || 8001);
const CORE_CHECK_INTERVAL = Number(process.env.CORE_CHECK_INTERVAL || 30000);
const CORE_FAIL_LIMIT = Number(process.env.CORE_FAIL_LIMIT || 3);
const CORE_GRACE_MS = Number(process.env.CORE_GRACE_MS || 120000);
const SUB_PATH = String(process.env.SUB_PATH || 'sub').replace(/^\/+/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const INNER_HOST = '127.0.0.1';

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseUrl(url) {
  try {
    const raw = String(url || '/').replace(/^\/+/, '/');
    return new URL(raw, 'http://localhost');
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
  value = value.replace(/\/+$/, '').toLowerCase();
  return value || '/';
}

function isSubscription(url) {
  const parsed = parseUrl(url);
  return parsed !== null && normalizePath(parsed.pathname) === normalizePath(`/${SUB_PATH}`);
}

function getToken(req, parsed) {
  const authorization = req.headers.authorization || '';
  const bearer = /^Bearer\s+/i.test(authorization)
    ? authorization.replace(/^Bearer\s+/i, '')
    : '';
  return parsed.searchParams.get('token') || req.headers['x-auth-token'] || bearer || '';
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (isSubscription(url)) {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = parseUrl(url);
    if (AUTH_TOKEN && !safeEqual(getToken(req, parsed), AUTH_TOKEN)) {
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
    console.error('proxy error:', error.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
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
  console.log(`auth gateway listening on :${PUBLIC_PORT} -> :${INNER_PORT}`);
  if (!AUTH_TOKEN) console.log('AUTH_TOKEN is empty, subscription is public');
});

let child;
if (process.env.SKIP_INNER !== '1') {
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env: { ...process.env, SERVER_PORT: String(INNER_PORT) },
    stdio: 'inherit',
  });


  if (process.env.CORE_WATCHDOG !== '0') {
    const net = require('net');
    const startedAt = Date.now();
    let failures = 0;
    const probe = () => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: CORE_PORT });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(3000, () => done(false));
      socket.on('connect', () => done(true));
      socket.on('error', () => done(false));
    });
    const timer = setInterval(async () => {
      if (Date.now() - startedAt < CORE_GRACE_MS) return;
      if (await probe()) {
        if (failures) console.log(`proxy core on :${CORE_PORT} is back`);
        failures = 0;
        return;
      }
      failures += 1;
      console.error(`proxy core on :${CORE_PORT} is not listening (${failures}/${CORE_FAIL_LIMIT})`);
      if (failures >= CORE_FAIL_LIMIT) {
        failures = 0;
        console.error('restarting the inner app to recover the proxy core');
        child.kill('SIGTERM');
      }
    }, CORE_CHECK_INTERVAL);
    timer.unref();
  }

  child.on('exit', (code, signal) => {
    console.error(`inner app exited (code=${code}, signal=${signal})`);
    server.close(() => process.exit(code === null ? 1 : code));
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (child) child.kill(signal);
    server.close(() => process.exit(0));
  });
}
