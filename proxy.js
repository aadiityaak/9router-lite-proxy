#!/usr/bin/env node
/**
 * LITE Proxy — Restricted OpenAI-compatible endpoint
 * 
 * - Only accepts token: (set via LITE_TOKEN env var)
 * - Forces model to "LITE" on every request
 * - Proxies to 9Router at http://127.0.0.1:20128
 * - Tracks usage in /home/ubuntu/lite-proxy/usage.log
 * - Serves dashboard at /usage (with cookie-based login)
 * - Real-time active request tracking + charts
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

// ─── Active Request Tracking ───────────────────────────────────
let activeRequests = 0;
let lastRequestAt = null;

const HTML_HEAD = (title) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    body { background: #f0f2f5; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }
    .stat-card { border: none; border-radius: 12px; transition: all .25s ease; cursor: default; }
    .stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.08); }
    .stat-card .num { font-size: 1.9rem; font-weight: 700; }
    .stat-card .icon-circle { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; }
    .table-wrap { max-height: 380px; overflow-y: auto; scrollbar-width: thin; }
    .table-wrap::-webkit-scrollbar { width: 6px; }
    .table-wrap::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
    .bg-model { background: #eef2ff; font-family: monospace; padding: 2px 8px; border-radius: 6px; font-size: .85em; }
    .card { border: none; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.04); }
    .card-header { background: transparent; border-bottom: 1px solid #eee; font-weight: 600; font-size: .9rem; }
    .live-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .live-dot.active { background: #22c55e; animation: pulse-dot 1.5s ease-in-out infinite; }
    .live-dot.idle { background: #94a3b8; }
    @keyframes pulse-dot { 0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,.5); } 50% { box-shadow: 0 0 0 8px rgba(34,197,94,0); } }
    @keyframes row-fade { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: translateX(0); } }
    .row-new { animation: row-fade .4s ease-out; }
    .navbar { backdrop-filter: blur(12px); background: rgba(15,23,42,.92) !important; }
    .chart-container { position: relative; height: 200px; }
    .badge-status { font-size: .75rem; font-weight: 500; padding: 3px 10px; }
  </style>
</head>`;

// ─── Login Page ─────────────────────────────────────────────────

function serveLogin(res, error) {
  const html = `${HTML_HEAD('Login — LITE Proxy')}
<body class="d-flex align-items-center min-vh-100" style="background: linear-gradient(135deg,#0f172a 0,#1e293b 100%)">
  <div class="container" style="max-width:420px">
    <div class="card shadow-lg border-0 rounded-4">
      <div class="card-body p-4">
        <div class="text-center mb-4">
          <div class="mx-auto mb-3 d-flex align-items-center justify-content-center" style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#3b82f6,#8b5cf6)">
            <i class="bi bi-lightning-charge-fill text-white fs-3"></i>
          </div>
          <h5 class="fw-bold">LITE Proxy Dashboard</h5>
          <p class="text-muted small">Masukkan password untuk melanjutkan</p>
        </div>
        ${error ? `<div class="alert alert-danger py-2 small rounded-3"><i class="bi bi-exclamation-circle me-1"></i>${error}</div>` : ''}
        <form method="POST" action="/login">
          <div class="mb-4">
            <input type="password" name="password" class="form-control form-control-lg rounded-3" placeholder="Password" autofocus required>
          </div>
          <button type="submit" class="btn btn-primary w-100 py-2 rounded-3 fw-semibold">Masuk</button>
        </form>
      </div>
    </div>
    <p class="text-center text-secondary small mt-4 opacity-75">LITE Proxy &mdash; lite.wsd.my.id</p>
  </div>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ─── Dashboard HTML (Bootstrap 5 + Chart.js) ────────────────────

function serveDashboard(res) {
  const html = `${HTML_HEAD('Dashboard — LITE Proxy')}
<body>
  <nav class="navbar navbar-dark px-3 py-2 shadow-sm">
    <div class="d-flex align-items-center gap-3">
      <span class="navbar-brand mb-0 fw-bold"><i class="bi bi-lightning-charge-fill text-warning me-1"></i> LITE Proxy</span>
      <span id="live-badge" class="badge bg-secondary rounded-pill small px-3 py-1">
        <span class="live-dot idle" id="live-dot"></span><span id="live-text">Idle</span>
      </span>
    </div>
    <div class="d-flex align-items-center gap-2">
      <span class="text-light-emphasis small d-none d-md-inline"><code class="text-light bg-dark bg-opacity-25 px-2 py-1 rounded">lite.wsd.my.id/v1</code></span>
      <a href="/logout" class="btn btn-outline-light btn-sm rounded-3"><i class="bi bi-box-arrow-right me-1"></i>Logout</a>
    </div>
  </nav>

  <div class="container-fluid py-3 px-4" style="max-width:1400px;margin:0 auto">
    <!-- Stat Cards -->
    <div class="row g-3 mb-4" id="stats">
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100 p-3">
          <div class="d-flex align-items-start gap-3">
            <div class="icon-circle" style="background:#eff6ff;color:#3b82f6"><i class="bi bi-arrow-up-short"></i></div>
            <div><div class="num" id="total-req">—</div><div class="text-muted small">Total Requests</div></div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100 p-3">
          <div class="d-flex align-items-start gap-3">
            <div class="icon-circle" style="background:#f0fdf4;color:#22c55e"><i class="bi bi-calendar-check"></i></div>
            <div><div class="num text-success" id="today-req">—</div><div class="text-muted small">Today</div></div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100 p-3">
          <div class="d-flex align-items-start gap-3">
            <div class="icon-circle" style="background:#faf5ff;color:#a855f7"><i class="bi bi-input-cursor-text"></i></div>
            <div><div class="num" style="color:#a855f7" id="total-in">—</div><div class="text-muted small">Tokens In</div></div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6">
        <div class="card stat-card h-100 p-3">
          <div class="d-flex align-items-start gap-3">
            <div class="icon-circle" style="background:#fff7ed;color:#f97316"><i class="bi bi-chat-dots"></i></div>
            <div><div class="num" style="color:#f97316" id="total-out">—</div><div class="text-muted small">Tokens Out</div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="row g-3 mb-4">
      <div class="col-md-7">
        <div class="card p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="fw-semibold small"><i class="bi bi-graph-up me-1 text-primary"></i>Request Timeline (30m)</span>
            <span class="badge bg-light text-muted small" id="total-chart">0 requests</span>
          </div>
          <div class="chart-container">
            <canvas id="timelineChart"></canvas>
          </div>
        </div>
      </div>
      <div class="col-md-5">
        <div class="card p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <span class="fw-semibold small"><i class="bi bi-pie-chart me-1 text-primary"></i>Model Distribution</span>
            <span class="badge bg-light text-muted small" id="model-count-chart">0 models</span>
          </div>
          <div class="chart-container d-flex align-items-center justify-content-center">
            <canvas id="modelChart" style="max-width:220px;max-height:190px"></canvas>
          </div>
        </div>
      </div>
    </div>

    <!-- Tables Row -->
    <div class="row g-3">
      <div class="col-md-5">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-boxes me-1"></i>By Model</span>
            <span class="badge bg-primary rounded-pill" id="model-count">0</span>
          </div>
          <div class="card-body p-0 table-wrap">
            <table class="table table-sm table-hover mb-0 align-middle">
              <thead class="table-light"><tr><th class="ps-3">Model</th><th class="text-end">Req</th><th class="text-end">Tokens In</th><th class="text-end pe-3">Tokens Out</th></tr></thead>
              <tbody id="model-rows"><tr><td colspan="4" class="text-center text-muted small py-4">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-md-7">
        <div class="card">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-clock-history me-1"></i>Recent Requests</span>
            <div class="d-flex gap-1">
              <button class="btn btn-sm btn-outline-secondary rounded-3" onclick="window.location.reload()" title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>
              <button class="btn btn-sm btn-outline-danger rounded-3" onclick="clearLog()" title="Clear All Logs"><i class="bi bi-trash3"></i></button>
            </div>
          </div>
          <div class="card-body p-0 table-wrap">
            <table class="table table-sm table-hover mb-0 align-middle">
              <thead class="table-light"><tr><th class="ps-3">Time</th><th>Requested → Forced</th><th class="text-end">Tokens</th><th class="text-center">Status</th><th class="text-end pe-3">Duration</th></tr></thead>
              <tbody id="recent-rows"><tr><td colspan="5" class="text-center text-muted small py-4">Loading...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
// ── Charts ──
let timelineChart, modelChart;
const TL_LABELS = [], TL_DATA = [];

function initCharts() {
  const ctx = document.getElementById('timelineChart').getContext('2d');
  timelineChart = new Chart(ctx, {
    type: 'line',
    data: { labels: TL_LABELS, datasets: [{
      label: 'Requests',
      data: TL_DATA,
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59,130,246,.08)',
      fill: true,
      tension: .35,
      pointRadius: 3,
      pointHoverRadius: 6,
      borderWidth: 2,
    }]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e293b', titleColor: '#fff', bodyColor: '#cbd5e1', cornerRadius: 8, padding: 10 } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 }, color: '#94a3b8' } },
        y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,.04)' }, ticks: { stepSize: 1, font: { size: 10 }, color: '#94a3b8' } }
      },
      animation: { duration: 600, easing: 'easeOutQuart' }
    }
  });

  const mctx = document.getElementById('modelChart').getContext('2d');
  modelChart = new Chart(mctx, {
    type: 'doughnut',
    data: { labels: [], datasets: [{ data: [], backgroundColor: ['#3b82f6','#a855f7','#f97316','#22c55e','#ef4444','#06b6d4','#eab308'], borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 8, font: { size: 10 }, color: '#64748b' } },
        tooltip: { backgroundColor: '#1e293b', titleColor: '#fff', bodyColor: '#cbd5e1', cornerRadius: 8, padding: 10 }
      },
      animation: { animateRotate: true, duration: 800 }
    }
  });
}

function updateChart(timeline) {
  if (!timelineChart) return;
  TL_LABELS.length = 0; TL_DATA.length = 0;
  (timeline||[]).forEach(p => { TL_LABELS.push(p.time); TL_DATA.push(p.requests); });
  timelineChart.update('default');
  const total = TL_DATA.reduce((a,b)=>a+b, 0);
  document.getElementById('total-chart').textContent = total + ' requests';
}

function updateModelChart(models) {
  if (!modelChart || !models) return;
  const labels = models.map(m => m.model);
  const data = models.map(m => m.requests);
  document.getElementById('model-count-chart').textContent = labels.length + ' model' + (labels.length!==1?'s':'');
  if (labels.length === 0) {
    modelChart.data.labels = ['No data']; modelChart.data.datasets[0].data = [1];
    modelChart.data.datasets[0].backgroundColor = ['#e2e8f0'];
  } else {
    modelChart.data.labels = labels; modelChart.data.datasets[0].data = data;
  }
  modelChart.update('default');
}

// ── Animate counter ──
function animateNum(el, target, duration=500) {
  const start = parseInt(el.textContent.replace(/[^0-9]/g,''))||0;
  if (start === target) return;
  const diff = target - start, startTime = performance.now();
  const step = (now) => {
    const p = Math.min((now-startTime)/duration, 1);
    el.textContent = Math.round(start + diff * this.easeOutCubic(p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function easeOutCubic(t) { return 1 - Math.pow(1-t, 3); }

// ── Live status ──
function updateLive(active) {
  const dot = document.getElementById('live-dot');
  const text = document.getElementById('live-text');
  const badge = document.getElementById('live-badge');
  if (active > 0) {
    dot.className = 'live-dot active';
    text.textContent = active + ' active';
    badge.className = 'badge bg-success rounded-pill small px-3 py-1';
  } else {
    dot.className = 'live-dot idle';
    text.textContent = 'Idle';
    badge.className = 'badge bg-secondary rounded-pill small px-3 py-1';
  }
}

// ── Main load ──
let prevRecent = [];

async function load() {
  try {
    const [s, m, r, t, q] = await Promise.all([
      fetch('/usage/api/stats').then(r=>r.json()),
      fetch('/usage/api/models').then(r=>r.json()),
      fetch('/usage/api/recent').then(r=>r.json()),
      fetch('/usage/api/timeline').then(r=>r.json()),
      fetch('/usage/api/status').then(r=>r.json()),
    ]);

    // Stats
    animateNum.call({easeOutCubic}, document.getElementById('total-req'), s.total_requests);
    animateNum.call({easeOutCubic}, document.getElementById('today-req'), s.today_requests);
    document.getElementById('total-in').textContent = s.total_tokens_in;
    document.getElementById('total-out').textContent = s.total_tokens_out;

    // Live
    updateLive(q.active);

    // Charts
    updateChart(t);
    updateModelChart(m);

    // Model table
    const mc = document.getElementById('model-count');
    const mRows = document.getElementById('model-rows');
    if (m && m.length) {
      mc.textContent = m.length;
      mRows.innerHTML = m.map(x => '<tr><td class="ps-3"><span class="bg-model">'+x.model+'</span></td><td class="text-end fw-medium">'+x.requests+'</td><td class="text-end">'+x.tokens_in+'</td><td class="text-end pe-3">'+x.tokens_out+'</td></tr>').join('');
    } else {
      mc.textContent = '0';
      mRows.innerHTML = '<tr><td colspan="4" class="text-center text-muted small py-4">No data</td></tr>';
    }

    // Recent table
    const rRows = document.getElementById('recent-rows');
    if (r && r.length) {
      rRows.innerHTML = r.map((x,i) => {
        const ts = new Date(x.timestamp).toLocaleString();
        const reqM = x.requested_model || '—';
        const isNew = i === 0 && (!prevRecent.length || x.timestamp !== prevRecent[0]?.timestamp);
        const anim = isNew ? 'row-new' : '';
        const stCls = x.status >= 200 && x.status < 300 ? 'bg-success' : 'bg-danger';
        return '<tr class="'+anim+'"><td class="ps-3 small text-nowrap">'+ts+'</td><td><span class="bg-model">'+reqM+'</span> <span class="text-muted">&rarr;</span> <span class="bg-model">LITE</span></td><td class="text-end">'+(x.tokens_in||0)+' / '+(x.tokens_out||0)+'</td><td class="text-center"><span class="badge badge-status '+stCls+'">'+x.status+'</span></td><td class="text-end pe-3 text-muted small">'+(x.duration_ms||0)+'ms</td></tr>';
      }).join('');
      prevRecent = r.slice(0,1);
    } else {
      rRows.innerHTML = '<tr><td colspan="5" class="text-center text-muted small py-4">No data</td></tr>';
      prevRecent = [];
    }
  } catch(e) { console.error(e); }
}

// ── Init ──
document.addEventListener('DOMContentLoaded', ()=>{
  initCharts();
  load();
  setInterval(load, 5000); // fast poll for live feel
});

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

  // Status (live active requests)
  if (p === '/usage/api/status' && method === 'GET') {
    return sendJson(res, 200, { active: activeRequests, lastAt: lastRequestAt });
  }

  // Timeline (requests per minute for last 30 min)
  if (p === '/usage/api/timeline' && method === 'GET') {
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(l => l.trim());
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;
      const buckets = {};
      for (let i = 0; i < 30; i++) {
        const t = new Date(cutoff + i * 60000);
        buckets[t.toISOString().substring(0, 16)] = 0; // YYYY-MM-DDTHH:mm
      }
      lines.forEach(l => {
        try {
          const e = JSON.parse(l);
          const ts = new Date(e.timestamp).getTime();
          if (ts >= cutoff) {
            const key = new Date(e.timestamp).toISOString().substring(0, 16);
            if (buckets[key] !== undefined) buckets[key]++;
          }
        } catch(e2) {}
      });
      const data = Object.entries(buckets).map(([time, count]) => ({
        time: time.substring(11), // HH:mm
        requests: count
      }));
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 200, []);
    }
    return;
  }

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
    if (method === 'GET') return serveLogin(res);
    if (method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const params = new URLSearchParams(body);
        if (params.get('password') === DASHBOARD_PASS) {
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
    if (cookies.lite_sesh) sessions.delete(cookies.lite_sesh);
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  // ─── Route: Dashboard (authed) ───
  if (path === '/usage' || path === '/usage/') {
    if (!isAuthed(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveDashboard(res);
  }

  // ─── Route: Dashboard API (authed) ───
  if (path.startsWith('/usage/api/')) {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Unauthorized' });
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

  // ─── Track active request ───
  activeRequests++;
  const startTime = Date.now();
  const cleanup = (tokens) => {
    activeRequests--;
    lastRequestAt = Date.now();
    logUsage(tokens);
  };

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
        activeRequests--;
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
            if (resp.usage) { tokensIn = resp.usage.prompt_tokens || 0; tokensOut = resp.usage.completion_tokens || 0; }
          } catch(e) {}
          cleanup({ timestamp: new Date().toISOString(), model: FORCED_MODEL, requested_model: requestedModel, tokens_in: tokensIn, tokens_out: tokensOut, status: upstreamRes.statusCode, duration_ms: duration });
        });
        res.writeHead(upstreamRes.statusCode, cleanHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', err => {
        const duration = Date.now() - startTime;
        cleanup({ timestamp: new Date().toISOString(), model: FORCED_MODEL, requested_model: requestedModel, tokens_in: 0, tokens_out: 0, status: 502, duration_ms: duration });
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
        const duration = Date.now() - startTime;
        const filtered = filterModelsOnly(body);
        const headers = cleanHeaders(upstreamRes.headers);
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        headers['content-length'] = Buffer.byteLength(filtered);
        // Log this as a models list request (no token usage)
        cleanup({ timestamp: new Date().toISOString(), model: FORCED_MODEL, tokens_in: 0, tokens_out: 0, status: upstreamRes.statusCode, duration_ms: duration });
        res.writeHead(upstreamRes.statusCode, headers);
        res.end(filtered);
      });
    });
    upstreamReq.on('error', err => { activeRequests--; sendJson(res, 502, { error: 'Bad Gateway', message: err.message }); });
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
          if (resp.usage) { tokensIn = resp.usage.prompt_tokens || 0; tokensOut = resp.usage.completion_tokens || 0; }
        } catch(e) {}
        cleanup({ timestamp: new Date().toISOString(), model: FORCED_MODEL, tokens_in: tokensIn, tokens_out: tokensOut, status: upstreamRes.statusCode, duration_ms: duration });
      });
    } else {
      // For streaming: cleanup when response ends
      upstreamRes.on('end', () => {
        cleanup({ timestamp: new Date().toISOString(), model: FORCED_MODEL, tokens_in: 0, tokens_out: 0, status: upstreamRes.statusCode, duration_ms: Date.now() - startTime });
      });
    }

    res.writeHead(upstreamRes.statusCode, cleanHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', err => { activeRequests--; sendJson(res, 502, { error: 'Bad Gateway', message: err.message }); });

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
