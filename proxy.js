#!/usr/bin/env node
/**
 * LITE Proxy — Restricted OpenAI-compatible endpoint
 * 
 * - Only accepts token: LITE_TOKEN_PLACEHOLDER
 * - Forces model to "LITE" on every request
 * - Proxies to 9Router at http://127.0.0.1:20128
 * - Tracks usage in /home/ubuntu/lite-proxy/usage.log
 * - Serves dashboard at /usage
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9099;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 20128;
const ALLOWED_TOKEN = process.env.LITE_TOKEN || (() => { throw new Error('Missing LITE_TOKEN env var') })();
const UPSTREAM_TOKEN = process.env.UPSTREAM_TOKEN || (() => { throw new Error('Missing UPSTREAM_TOKEN env var') })();
const FORCED_MODEL = 'LITE';
const LOG_FILE = '/home/ubuntu/lite-proxy/usage.log';

// ─── Helpers ───────────────────────────────────────────────────

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Clean conflicting headers for upstream responses
function cleanHeaders(headers) {
  const cleaned = { ...headers };
  const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'];
  hopByHop.forEach(h => delete cleaned[h]);
  if (cleaned['content-length'] && cleaned['transfer-encoding']) {
    delete cleaned['transfer-encoding'];
  }
  return cleaned;
}

// Filter /v1/models response
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

// Log a usage entry
function logUsage(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) { /* ignore */ }
}

// ─── Dashboard HTML ────────────────────────────────────────────

function serveDashboard(res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LITE Proxy — Usage</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:20px; background:#0d1117; color:#c9d1d9 }
    .w { max-width:1200px; margin:0 auto }
    h1 { font-size:1.8em; color:#f0f6fc; margin-bottom:20px }
    h2 { font-size:1.2em; color:#e6edf3; margin-bottom:10px }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-bottom:24px }
    .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px }
    .num { font-size:1.8em; font-weight:700; color:#58a6ff }
    .lbl { color:#8b949e; font-size:.85em; margin-top:4px }
    table { width:100%; border-collapse:collapse }
    th,td { padding:8px 10px; text-align:left; border-bottom:1px solid #30363d; font-size:.9em }
    th { position:sticky; top:0; background:#0d1117; color:#8b949e; font-weight:600 }
    .ok { color:#3fb950 }
    .err { color:#f85149 }
    code { background:#21262d; padding:2px 6px; border-radius:4px; font-size:.85em }
    .ref { position:fixed; top:20px; right:20px; background:#238636; color:#fff; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-size:.9em }
    .ref:hover { background:#2ea043 }
    .table-wrap { max-height:400px; overflow-y:auto }
  </style>
</head>
<body>
<div class="w">
  <button class="ref" onclick="location.reload()">🔄 Refresh</button>
  <h1>🔒 LITE Proxy Usage</h1>
  <p style="margin-bottom:20px;color:#8b949e">Endpoint <code>lite.wsd.my.id/v1</code></p>

  <div class="grid" id="stats">
    <div class="card"><div class="num" id="total-req">—</div><div class="lbl">Total Requests</div></div>
    <div class="card"><div class="num" id="today-req">—</div><div class="lbl">Today</div></div>
    <div class="card"><div class="num" id="total-in">—</div><div class="lbl">Tokens In</div></div>
    <div class="card"><div class="num" id="total-out">—</div><div class="lbl">Tokens Out</div></div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <h2>📈 By Model</h2>
    <div class="table-wrap">
    <table><thead><tr><th>Model</th><th>Requests</th><th>Tokens In</th><th>Tokens Out</th></tr></thead>
      <tbody id="model-rows"><tr><td colspan="4" style="text-align:center;color:#8b949e">Loading...</td></tr></tbody>
    </table>
    </div>
  </div>

  <div class="card">
    <h2>🕐 Recent</h2>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span></span>
      <button class="ref" onclick="clearLog()">🗑️ Clear Log</button>
    </div>
    <div class="table-wrap">
    <table><thead><tr><th>Time</th><th>Requested → Forced</th><th>Tokens In/Out</th><th>Status</th><th>Duration</th></tr></thead>
      <tbody id="recent-rows"><tr><td colspan="5" style="text-align:center;color:#8b949e">Loading...</td></tr></tbody>
    </table>
    </div>
  </div>
</div>
<script>
async function load() {
  const [s, m, r] = await Promise.all([
    fetch('/usage/api/stats').then(r=>r.json()),
    fetch('/usage/api/models').then(r=>r.json()),
    fetch('/usage/api/recent').then(r=>r.json())
  ]);
  if(s.error) { document.querySelector('#stats').innerHTML='<div class="card"><div class="lbl">'+s.error+'</div></div>'; return }
  document.getElementById('total-req').textContent=s.total_requests;
  document.getElementById('today-req').textContent=s.today_requests;
  document.getElementById('total-in').textContent=s.total_tokens_in;
  document.getElementById('total-out').textContent=s.total_tokens_out;

  document.getElementById('model-rows').innerHTML=(m||[]).map(x=>
    '<tr><td><code>'+x.model+'</code></td><td>'+x.requests+'</td><td>'+x.tokens_in+'</td><td>'+x.tokens_out+'</td></tr>'
  ).join('');

  document.getElementById('recent-rows').innerHTML=(r||[]).map(x=>
    '<tr><td>'+new Date(x.timestamp).toLocaleString()+'</td><td><code>'+(x.requested_model||x.model||'')+'</code> &rarr; <code>LITE</code></td><td>'+(x.tokens_in||0)+' / '+(x.tokens_out||0)+'</td><td class="'+(x.status==200?'ok':'err')+'">'+x.status+'</td><td>'+(x.duration_ms||0)+'ms</td></tr>'
  ).join('');
}
load();
setInterval(load,15000);

async function clearLog() {
  if (!confirm('Yakin mau clear semua log usage?')) return;
  try {
    const r = await fetch('/usage/api/clear', { method: 'DELETE' });
    const d = await r.json();
    if (d.success) {
      load();
    } else {
      alert('Gagal: ' + (d.error || d.message));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  }
}
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ─── API endpoints ─────────────────────────────────────────────

function handleAPI(method, url, res) {
  // Parse the path
  const p = url.pathname;

  // Stats
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
          if (new Date(e.timestamp) >= today) {
            stats.today_requests++;
          }
        } catch(e2) {}
      });
      
      sendJson(res, 200, stats);
    } catch (e) {
      sendJson(res, 200, { total_requests: 0, today_requests: 0, total_tokens_in: 0, total_tokens_out: 0 });
    }
    return;
  }

  // Recent
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

  // By model
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

  // Clear log
  if (p === '/usage/api/clear' && method === 'DELETE') {
    try {
      fs.writeFileSync(LOG_FILE, '', 'utf8');
      sendJson(res, 200, { success: true, message: 'Log cleared' });
    } catch (e) {
      sendJson(res, 500, { error: 'Failed to clear log', message: e.message });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
}

// ─── Main Proxy ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // ─── Route: Dashboard HTML ───
  if (path === '/usage' || path === '/usage/') {
    return serveDashboard(res);
  }

  // ─── Route: API ───
  if (path.startsWith('/usage/api/')) {
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
        // Log usage (collect token counts from response)
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

        // Forward response
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
    // Collect response for token tracking
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
