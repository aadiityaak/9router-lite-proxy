#!/usr/bin/env node
/**
 * LITE Proxy — Restricted OpenAI-compatible endpoint
 * 
 * - Only accepts token: LITE_TOKEN_PLACEHOLDER
 * - Forces model to "LITE" on every request
 * - Proxies to 9Router at http://127.0.0.1:20128
 * - Tracks usage in /home/ubuntu/lite-proxy/usage.log
 * - Serves dashboard at /usage (with cookie-based login)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 9099;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 20128;
const ALLOWED_TOKEN = process.env.LITE_TOKEN || (() => { throw new Error('Missing LITE_TOKEN env var') })();
const UPSTREAM_TOKEN = process.env.UPSTREAM_TOKEN || (() => { throw new Error('Missing UPSTREAM_TOKEN env var') })();
const FORCED_MODEL = 'LITE';
const LOG_FILE = '/home/ubuntu/lite-proxy/usage.log';

// ─── Dashboard Auth ─────────────────────────────────────────────
const DASHBOARD_USER = 'dashboard';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'jhdRZUM65hYevq9L';
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h
const sessions = new Map();

function parseCookies(hdr) {
  const obj = {};
  (hdr || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) obj[k.trim()] = v.join('=').trim();
  });
  return obj;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `lite_sesh=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.lite_sesh;
  if (!token || !sessions.has(token)) return false;
  // Extend session on activity
  sessions.set(token, Date.now());
  return true;
}

// Clean stale sessions every 10m
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL * 2;
  for (const [k, v] of sessions) {
    if (v < cutoff) sessions.delete(k);
  }
}, 600000);

const HTML_HEAD = (title) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
  <style>
    body { background:#f8f9fa }
    .stat-card { border-left:4px solid #0d6efd }
    .stat-card .num { font-size:2rem; font-weight:700 }
    .table-wrap { max-height:400px; overflow-y:auto }
    .bg-model { background:#e8f4f8; font-family:monospace; padding:2px 8px; border-radius:4px }
  </style>
</head>`;

// ─── Login Page ─────────────────────────────────────────────────

function serveLogin(res, error) {
  const html = `${HTML_HEAD('Login — LITE Proxy')}
<body class="d-flex align-items-center min-vh-100">
  <div class="container" style="max-width:400px">
    <div class="card shadow">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <i class="bi bi-shield-lock fs-1 text-primary"></i>
          <h4 class="mt-2">LITE Proxy Dashboard</h4>
          <p class="text-muted small">Masukkan password untuk melanjutkan</p>
        </div>
        ${error ? `<div class="alert alert-danger py-2 small">${error}</div>` : ''}
        <form method="POST" action="/login">
          <div class="mb-3">
            <label class="form-label">Password</label>
            <input type="password" name="password" class="form-control" autofocus required>
          </div>
          <button type="submit" class="btn btn-primary w-100">Masuk</button>
        </form>
      </div>
    </div>
    <p class="text-center text-muted small mt-3">LITE Proxy &mdash; lite.wsd.my.id</p>
  </div>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ─── Dashboard HTML (Bootstrap 5) ───────────────────────────────

function serveDashboard(res) {
  const html = `${HTML_HEAD('Dashboard — LITE Proxy')}
<body>
  <nav class="navbar navbar-dark bg-dark px-3">
    <span class="navbar-brand mb-0 h1"><i class="bi bi-lightning-charge-fill text-warning"></i> LITE Proxy</span>
    <div>
      <span class="text-light me-3 small"><code class="text-light bg-secondary px-2 py-1 rounded">lite.wsd.my.id/v1</code></span>
      <a href="/logout" class="btn btn-outline-light btn-sm"><i class="bi bi-box-arrow-right"></i> Logout</a>
    </div>
  </nav>

  <div class="container-fluid py-3 px-4">
    <!-- Stat cards -->
    <div class="row g-3 mb-4" id="stats">
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100">
          <div class="card-body">
            <div class="num" id="total-req">—</div>
            <div class="text-muted small">Total Requests</div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100" style="border-left-color:#198754">
          <div class="card-body">
            <div class="num text-success" id="today-req">—</div>
            <div class="text-muted small">Today</div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100" style="border-left-color:#6f42c1">
          <div class="card-body">
            <div class="num text-primary" id="total-in">—</div>
            <div class="text-muted small">Tokens In</div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100" style="border-left-color:#fd7e14">
          <div class="card-body">
            <div class="num text-warning" id="total-out">—</div>
            <div class="text-muted small">Tokens Out</div>
          </div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <!-- Models -->
      <div class="col-md-5">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-boxes"></i> By Model</span>
            <span class="badge bg-primary rounded-pill" id="model-count">0</span>
          </div>
          <div class="card-body p-0 table-wrap">
            <table class="table table-sm table-hover mb-0">
              <thead class="table-light"><tr><th>Model</th><th class="text-end">Req</th><th class="text-end">Tokens In</th><th class="text-end">Tokens Out</th></tr></thead>
              <tbody id="model-rows"><tr><td colspan="4" class="text-center text-muted small py-3">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Recent -->
      <div class="col-md-7">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-clock-history"></i> Recent</span>
            <div>
              <button class="btn btn-sm btn-outline-secondary me-1" onclick="window.location.reload()"><i class="bi bi-arrow-clockwise"></i></button>
              <button class="btn btn-sm btn-outline-danger" onclick="clearLog()"><i class="bi bi-trash3"></i></button>
            </div>
          </div>
          <div class="card-body p-0 table-wrap">
            <table class="table table-sm table-hover mb-0">
              <thead class="table-light"><tr><th>Time</th><th>Requested → Forced</th><th class="text-end">Tokens</th><th class="text-center">Status</th><th class="text-end">Duration</th></tr></thead>
              <tbody id="recent-rows"><tr><td colspan="5" class="text-center text-muted small py-3">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
async function load() {
  try {
    const [s, m, r] = await Promise.all([
      fetch('/usage/api/stats').then(r=>r.json()),
      fetch('/usage/api/models').then(r=>r.json()),
      fetch('/usage/api/recent').then(r=>r.json())
    ]);
    document.getElementById('total-req').textContent=s.total_requests;
    document.getElementById('today-req').textContent=s.today_requests;
    document.getElementById('total-in').textContent=s.total_tokens_in;
    document.getElementById('total-out').textContent=s.total_tokens_out;
    const mRows = document.getElementById('model-rows');
    if (m && m.length) {
      document.getElementById('model-count').textContent=m.length;
      mRows.innerHTML=m.map(x=>'<tr><td><span class="bg-model">'+x.model+'</span></td><td class="text-end">'+x.requests+'</td><td class="text-end">'+x.tokens_in+'</td><td class="text-end">'+x.tokens_out+'</td></tr>').join('');
    } else {
      mRows.innerHTML='<tr><td colspan="4" class="text-center text-muted small py-3">No data</td></tr>';
    }
    const rRows = document.getElementById('recent-rows');
    if (r && r.length) {
      rRows.innerHTML=r.map(x=>{
        const ts=new Date(x.timestamp).toLocaleString();
        const reqM=x.requested_model||'—';
        const cls=x.status>=200&&x.status<300?'text-success':'text-danger';
        return '<tr><td class="small">'+ts+'</td><td><span class="bg-model">'+reqM+'</span> &rarr; <span class="bg-model">LITE</span></td><td class="text-end">'+(x.tokens_in||0)+' / '+(x.tokens_out||0)+'</td><td class="text-center"><span class="badge bg-'+cls+'">'+x.status+'</span></td><td class="text-end text-muted small">'+(x.duration_ms||0)+'ms</td></tr>'
      }).join('');
    } else {
      rRows.innerHTML='<tr><td colspan="5" class="text-center text-muted small py-3">No data</td></tr>';
    }
  } catch(e) {}
}
load();
setInterval(load,15000);

async function clearLog() {
  if (!confirm('Yakin mau clear semua log usage?')) return;
  try {
    const r = await fetch('/usage/api/clear', { method: 'DELETE' });
    const d = await r.json();
    if (d.success) load(); else alert('Gagal: '+(d.error||d.message));
  } catch(e) { alert('Error: '+e.message); }
}
</script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ─── API endpoints ─────────────────────────────────────────────

function handleAPI(method, url, res) {
  const p = url.pathname;

  if (p === '/usage/api/stats' && method === 'GET') {
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const today = new Date(); today.setHours(0,0,0,0);
      const stats = { total_requests: 0, today_requests: 0, total_tokens_in: 0, total_tokens_out: 0 };
      lines.forEach(l => {
        try {
          const e = JSON.parse(l);
          stats.total_requests++;
          stats.total_tokens_in += e.tokens_in || 0;
          stats.total_tokens_out += e.tokens_out || 0;
          if (new Date(e.timestamp) >= today) stats.today_requests++;
        } catch(e2) {}
      });
      sendJson(res, 200, stats);
    } catch (e) {
      sendJson(res, 200, { total_requests: 0, today_requests: 0, total_tokens_in: 0, total_tokens_out: 0 });
    }
    return;
  }

  if (p === '/usage/api/recent' && method === 'GET') {
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim()).slice(-100);
      sendJson(res, 200, lines.map(l => {
        try { return JSON.parse(l); } catch(e) { return null; }
      }).filter(Boolean));
    } catch (e) {
      sendJson(res, 200, []);
    }
    return;
  }

  if (p === '/usage/api/models' && method === 'GET') {
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const map = {};
      lines.forEach(l => {
        try {
          const e = JSON.parse(l);
          const m = e.model || 'unknown';
          if (!map[m]) map[m] = { model: m, requests: 0, tokens_in: 0, tokens_out: 0 };
          map[m].requests++;
          map[m].tokens_in += e.tokens_in || 0;
          map[m].tokens_out += e.tokens_out || 0;
        } catch(e2) {}
      });
      sendJson(res, 200, Object.values(map));
    } catch (e) {
      sendJson(res, 200, []);
    }
    return;
  }

  if (p === '/usage/api/clear' && method === 'DELETE') {
    try {
      fs.writeFileSync(LOG_FILE, '', 'utf8');
      sendJson(res, 200, { success: true, message: 'Log cleared' });
    } catch (e) {
      sendJson(res, 500, { error: 'Failed to clear log', message: e.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ─── Helpers ───────────────────────────────────────────────────

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function cleanHeaders(headers) {
  const cleaned = { ...headers };
  const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'];
  hopByHop.forEach(h => delete cleaned[h]);
  if (cleaned['content-length'] && cleaned['transfer-encoding']) {
    delete cleaned['transfer-encoding'];
  }
  return cleaned;
}

function filterModelsOnly(body) {
  try {
    const data = JSON.parse(body);
    if (data && data.object === 'list' && Array.isArray(data.data)) {
      data.data = data.data.filter(m => m.id === FORCED_MODEL);
    }
    return JSON.stringify(data);
  } catch {
    return body;
  }
}

function logUsage(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { /* ignore */ }
}

// ─── Main Proxy ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // ─── Route: Login page ───
  if (path === '/login') {
    if (method === 'GET') {
      return serveLogin(res);
    }
    if (method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const pass = params.get('password');
        if (pass === DASHBOARD_PASS) {
          const token = createSession();
          setSessionCookie(res, token);
          res.writeHead(302, { Location: '/usage' });
          return res.end();
        }
        serveLogin(res, 'Password salah. Coba lagi.');
      });
      return;
    }
  }

  // ─── Route: Logout ───
  if (path === '/logout') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.lite_sesh;
    if (token) sessions.delete(token);
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  // ─── Route: Dashboard (authed) ───
  if (path === '/usage' || path === '/usage/') {
    if (!isAuthed(req)) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    return serveDashboard(res);
  }

  // ─── Route: Dashboard API (authed) ───
  if (path.startsWith('/usage/api/')) {
    if (!isAuthed(req)) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    return handleAPI(method, url, res);
  }

  // ─── Only check auth for actual API paths (/v1/...) ───
  if (!path.startsWith('/v1/')) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  // ─── Auth check ───
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${ALLOWED_TOKEN}`) {
    return sendJson(res, 401, { error: 'Unauthorized. Invalid or missing API key.' });
  }

  // ─── Track timing ───
  const startTime = Date.now();

  // ─── Upstream options ───
  const options = {
    hostname: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: req.url,
    method: method,
    headers: {
      'Authorization': UPSTREAM_TOKEN,
      'Host': `127.0.0.1:${UPSTREAM_PORT}`,
      'Accept': req.headers['accept'] || '*/*',
    },
  };
  if (req.headers['content-type']) options.headers['content-type'] = req.headers['content-type'];

  // ─── POST with JSON: intercept & force model ───
  if (method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let reqData;
      try {
        reqData = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON', message: e.message });
      }
      
      const requestedModel = reqData.model || 'unknown';
      reqData.model = FORCED_MODEL;
      const newBody = JSON.stringify(reqData);
      options.headers['content-length'] = Buffer.byteLength(newBody);

      const upstreamReq = http.request(options, upstreamRes => {
        let responseBody = '';
        upstreamRes.on('data', c => responseBody += c);
        upstreamRes.on('end', () => {
          const duration = Date.now() - startTime;
          let tokensIn = 0, tokensOut = 0;
          try {
            const resp = JSON.parse(responseBody);
            if (resp.usage) {
              tokensIn = resp.usage.prompt_tokens || 0;
              tokensOut = resp.usage.completion_tokens || 0;
            }
          } catch(e) {}
          
          logUsage({
            timestamp: new Date().toISOString(),
            model: FORCED_MODEL,
            requested_model: requestedModel,
            tokens_in: tokensIn,
            tokens_out: tokensOut,
            status: upstreamRes.statusCode,
            duration_ms: duration,
          });
        });

        res.writeHead(upstreamRes.statusCode, cleanHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', err => {
        const duration = Date.now() - startTime;
        logUsage({ timestamp: new Date().toISOString(), model: FORCED_MODEL, requested_model: requestedModel, tokens_in: 0, tokens_out: 0, status: 502, duration_ms: duration });
        sendJson(res, 502, { error: 'Bad Gateway', message: err.message });
      });

      upstreamReq.end(newBody);
    });
    return;
  }

  // ─── GET /v1/models — filter to only LITE ───
  if (method === 'GET' && (path === '/v1/models' || path === '/v1/models/')) {
    const upstreamReq = http.request(options, upstreamRes => {
      let body = '';
      upstreamRes.on('data', c => body += c);
      upstreamRes.on('end', () => {
        const filtered = filterModelsOnly(body);
        const headers = cleanHeaders(upstreamRes.headers);
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        headers['content-length'] = Buffer.byteLength(filtered);
        res.writeHead(upstreamRes.statusCode, headers);
        res.end(filtered);
      });
    });
    upstreamReq.on('error', err => sendJson(res, 502, { error: 'Bad Gateway', message: err.message }));
    upstreamReq.end();
    return;
  }

  // ─── Everything else: passthrough ───
  const upstreamReq = http.request(options, upstreamRes => {
    let responseBody = '';
    const isStreaming = (upstreamRes.headers['content-type'] || '').includes('text/event-stream');
    
    if (!isStreaming) {
      upstreamRes.on('data', c => responseBody += c);
      upstreamRes.on('end', () => {
        const duration = Date.now() - startTime;
        let tokensIn = 0, tokensOut = 0;
        try {
          const resp = JSON.parse(responseBody);
          if (resp.usage) {
            tokensIn = resp.usage.prompt_tokens || 0;
            tokensOut = resp.usage.completion_tokens || 0;
          }
        } catch(e) {}
        logUsage({
          timestamp: new Date().toISOString(),
          model: FORCED_MODEL,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          status: upstreamRes.statusCode,
          duration_ms: duration,
        });
      });
    }

    res.writeHead(upstreamRes.statusCode, cleanHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', err => sendJson(res, 502, { error: 'Bad Gateway', message: err.message }));
  
  if (method !== 'GET' && method !== 'HEAD') {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
});

// ─── Shutdown ──────────────────────────────────────────────────

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ─────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LITE proxy on http://127.0.0.1:${PORT}`);
  console.log(`Upstream: http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  console.log(`Forced model: ${FORCED_MODEL}`);
  console.log(`Dashboard: http://127.0.0.1:${PORT}/usage`);
});
