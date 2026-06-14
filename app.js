/* =========================================================================
   System Monitor — Frontend v2
   - Sparkline-Charts (inline SVG, keine Libraries)
   - Per-Core-CPU-Balken
   - Disk-I/O- und Netzwerk-Total-Anzeigen
   - Theme-Persistenz via localStorage
   - Polling mit Exponential-Backoff bei Fehlern
   - Schwellwert-Klassifikation (ok / warn / danger)
   ========================================================================= */

const API_BASE = (location.protocol === 'file:') ? 'http://localhost:10800' : location.origin;
const HISTORY_LEN = 60;          // wie viele Samples die Sparkline behält
const POLL_MIN_MS = 1000;
const POLL_MAX_MS = 30000;

// ── State ────────────────────────────────────────────────────────────────
const State = {
  config:  null,
  refreshMs: 3000,
  history: {},   // metric -> [{t, v}]
  errorCount: 0,
  pollTimer: null,
  systemInfo: null,
};

const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function fmt(n, dec = 1) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(dec);
}

function fmtKbps(kbps) {
  if (kbps == null || isNaN(kbps)) return '—';
  if (kbps >= 1024 * 1024) return (kbps / 1024 / 1024).toFixed(2) + ' GB/s';
  if (kbps >= 1024) return (kbps / 1024).toFixed(2) + ' MB/s';
  return kbps.toFixed(1) + ' KB/s';
}

function fmtMbps(mbps) {
  if (mbps == null || isNaN(mbps)) return '—';
  if (mbps >= 1024) return (mbps / 1024).toFixed(2) + ' GB/s';
  if (mbps < 0.1)   return (mbps * 1024).toFixed(0) + ' KB/s';
  return mbps.toFixed(2) + ' MB/s';
}

// ── Theme ────────────────────────────────────────────────────────────────
(function initTheme() {
  const stored = localStorage.getItem('sysmon-theme');
  const auto = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = stored || auto;
  document.documentElement.setAttribute('data-theme', theme);

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('sysmon-theme', next);
    });
  });
})();

// ── Schwellwert-Klassifikation ───────────────────────────────────────────
function classify(value, thresholds) {
  if (value == null || !thresholds) return 'ok';
  if (value >= (thresholds.danger ?? 1e9)) return 'danger';
  if (value >= (thresholds.warn   ?? 1e9)) return 'warn';
  return 'ok';
}

function setBar(barId, pct, alertLevel) {
  const bar = $(barId);
  if (!bar) return;
  bar.style.width = Math.min(Math.max(pct ?? 0, 0), 100) + '%';
  bar.className = 'progress-fill ' + (alertLevel || 'ok');
}

// ── Sparkline (inline SVG) ───────────────────────────────────────────────
function pushHistory(metric, value) {
  const arr = State.history[metric] ||= [];
  arr.push({ t: Date.now(), v: value });
  while (arr.length > HISTORY_LEN) arr.shift();
}

function sparkline(metric, opts = {}) {
  const arr = State.history[metric] || [];
  const w = opts.width  ?? 100;
  const h = opts.height ?? 28;
  if (arr.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  }
  const vals = arr.map(p => (p.v == null ? 0 : p.v));
  const minV = opts.min ?? Math.min(...vals);
  const maxV = opts.max ?? Math.max(...vals, minV + 1);
  const range = Math.max(maxV - minV, 1);
  const stepX = w / (HISTORY_LEN - 1);
  const points = arr.map((p, i) => {
    const x = i * stepX;
    const y = h - ((p.v ?? minV) - minV) / range * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Fläche unter der Linie
  const last = arr.length - 1;
  const lastX = last * stepX;
  const area = `${points} ${lastX.toFixed(1)},${h} 0,${h}`;
  const cls = opts.cls || '';
  return `
    <svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polygon class="spark-area" points="${area}"/>
      <polyline class="spark-line" points="${points}"/>
    </svg>`;
}

// ── Render: Topbar + Übersicht ───────────────────────────────────────────
function renderTopbar(d) {
  $('hostname').textContent = d.hostname || '—';
  $('uptime').textContent = 'Uptime: ' + (d.uptime || '—');
  const now = new Date();
  $('timestamp').textContent = now.toLocaleTimeString('de-DE',
    { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderCpu(d) {
  const cpu = d.cpu || {};
  const lvl = d.alerts?.cpu || 'ok';
  $('cpu-pct').textContent = fmt(cpu.percent) + '%';
  $('cpu-pct').className = 'card-value ' + lvl;
  const freqStr = cpu.freq_ghz ? ` @ ${cpu.freq_ghz} GHz` : '';
  const coreStr = cpu.cores ? ` (${cpu.cores}C/${cpu.threads || cpu.cores}T)` : '';
  $('cpu-info').textContent = (cpu.info || 'CPU') + freqStr + coreStr;
  setBar('cpu-bar', cpu.percent, lvl);

  // Per-Core
  const perCore = cpu.per_core || [];
  const grid = $('cpu-cores');
  if (grid) {
    grid.innerHTML = perCore.map((c, i) => {
      const cl = c >= 90 ? 'danger' : c >= 70 ? 'warn' : 'ok';
      return `<div class="core" title="Core ${i}: ${c.toFixed(1)}%">
        <span class="core-bar"><span class="core-fill ${cl}" style="width:${Math.min(c, 100)}%"></span></span>
        <span class="core-label">${i}</span>
      </div>`;
    }).join('');
  }
  // Sparkline
  const sparkHost = $('cpu-spark');
  if (sparkHost) sparkHost.innerHTML = sparkline('cpu', { min: 0, max: 100, cls: lvl });

  // Temp neben Sparkline
  const tempEl = $('cpu-temp');
  if (tempEl) {
    if (cpu.temp != null) {
      const tlvl = d.alerts?.cpu_temp || 'ok';
      tempEl.innerHTML = `<span class="temp-badge ${tlvl}">${fmt(cpu.temp, 0)}°C</span>`;
    } else tempEl.innerHTML = '';
  }
}

function renderRam(d) {
  const ram = d.ram || {};
  const lvl = d.alerts?.ram || 'ok';
  $('ram-pct').textContent = fmt(ram.percent) + '%';
  $('ram-pct').className = 'card-value ' + lvl;
  $('ram-info').textContent =
    `${ram.used_gb} GB / ${ram.total_gb} GB (Frei: ${ram.free_gb} GB)`;
  setBar('ram-bar', ram.percent, lvl);
  const sparkHost = $('ram-spark');
  if (sparkHost) sparkHost.innerHTML = sparkline('ram', { min: 0, max: 100, cls: lvl });

  // Swap
  const swap = $('ram-swap');
  if (swap) {
    if (ram.swap_total_gb > 0) {
      swap.style.display = '';
      swap.textContent = `Swap: ${ram.swap_used_gb} / ${ram.swap_total_gb} GB (${fmt(ram.swap_percent, 0)}%)`;
    } else {
      swap.style.display = 'none';
    }
  }
}

function renderDisks(d) {
  // Multi-Disk-Liste
  const container = $('disk-list');
  if (container) {
    const disks = d.disks?.length ? d.disks : [{
      label: d.disk.label, percent: d.disk.percent,
      used_gb: d.disk.used_gb, total_gb: d.disk.total_gb, free_gb: d.disk.free_gb,
    }];
    container.innerHTML = disks.map((dd, i) => {
      const pct = dd.percent ?? 0;
      const cl = pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
      return `
        <div class="disk-item">
          <div class="disk-item-header">
            <span class="disk-label">${escHtml(dd.label)}</span>
            <span class="disk-pct-badge ${cl}">${pct.toFixed(1)}%</span>
          </div>
          <div class="progress-bar disk-progress">
            <div class="progress-fill ${cl}" style="width:${Math.min(pct,100)}%"></div>
          </div>
          <div class="disk-item-info">${dd.used_gb} GB / ${dd.total_gb} GB <span class="disk-free">(Frei: ${dd.free_gb} GB)</span></div>
        </div>`;
    }).join('');
  }

  // Disk-I/O
  const io = $('disk-io');
  if (io && d.disk) {
    io.innerHTML = `
      <span class="io-pill"><span class="io-arrow">↓</span> ${fmtMbps(d.disk.read_mbps)}</span>
      <span class="io-pill"><span class="io-arrow">↑</span> ${fmtMbps(d.disk.write_mbps)}</span>`;
  }
  const sparkHost = $('disk-spark');
  if (sparkHost) sparkHost.innerHTML = sparkline('disk_read', { min: 0, cls: 'accent' });
}

function renderNetwork(d) {
  const net = d.network || {};
  const container = $('net-interfaces-list');
  if (container) {
    const ifaces = net.interfaces?.length ? net.interfaces : [{
      name: net.name, ip: net.ip,
      dl_kbps: net.dl_kbps, ul_kbps: net.ul_kbps,
      sent_gb: net.sent_gb, recv_gb: net.recv_gb,
    }];
    container.innerHTML = ifaces.map((ifc, i) => {
      const dlActive = ifc.dl_kbps > 500;
      const ulActive = ifc.ul_kbps > 100;
      return `
        <div class="net-iface${i === 0 ? ' net-iface-primary' : ''}">
          <div class="net-iface-header">
            <span class="net-iface-name">${escHtml(ifc.name)}</span>
            <span class="net-iface-ip">${escHtml(ifc.ip)}</span>
          </div>
          <div class="net-iface-speeds">
            <span class="net-speed-item">
              <span class="net-arrow">↓</span>
              <span class="net-speed-val ${dlActive ? 'net-active' : ''}">${fmtKbps(ifc.dl_kbps)}</span>
            </span>
            <span class="net-speed-item">
              <span class="net-arrow">↑</span>
              <span class="net-speed-val ${ulActive ? 'net-active' : ''}">${fmtKbps(ifc.ul_kbps)}</span>
            </span>
            <span class="net-traffic">↓ ${fmt(ifc.recv_gb, 2)} GB</span>
            <span class="net-traffic">↑ ${fmt(ifc.sent_gb, 2)} GB</span>
          </div>
        </div>`;
    }).join('');
  }
  const sparkHost = $('net-spark');
  if (sparkHost) sparkHost.innerHTML = sparkline('net_dl', { min: 0, cls: 'accent' });
}

function renderBattery(d) {
  const bat = d.battery;
  if (!bat) {
    $('bat-val').textContent = 'Kein Akku';
    $('bat-sub').textContent = 'Netzbetrieb';
    setBar('bat-bar', 0, 'ok');
    return;
  }
  const lvl = bat.percent < 10 ? 'danger' : bat.percent < 25 ? 'warn' : 'ok';
  $('bat-val').textContent = bat.percent.toFixed(0) + '%';
  $('bat-val').className = 'card-value ' + lvl;
  $('bat-sub').textContent = bat.plugged ? 'Netzbetrieb' : 'Akkubetrieb';
  setBar('bat-bar', bat.percent, lvl);
}

function renderGpu(d) {
  if (!d.gpu) {
    ['gpu-load','gpu-temp-val','vram-pct'].forEach(id => $(id) && ($(id).textContent = '—'));
    $('gpu-name') && ($('gpu-name').textContent = 'Keine GPU erkannt');
    $('gpu-power') && ($('gpu-power').textContent = '');
    $('vram-info') && ($('vram-info').textContent = '');
    return;
  }
  const g = d.gpu;
  const tlvl = d.alerts?.gpu_temp || 'ok';

  if (g.load != null) {
    $('gpu-load').textContent = g.load.toFixed(1) + '%';
    setBar('gpu-bar', g.load, g.load >= 90 ? 'danger' : g.load >= 70 ? 'warn' : 'ok');
  } else {
    $('gpu-load').textContent = '—';
  }
  const memInfo = g.mem_total_gb ? ` | VRAM: ${g.mem_total_gb} GB` : '';
  $('gpu-name').textContent = (g.name || 'GPU') + memInfo;

  if (g.temp != null) {
    $('gpu-temp-val').innerHTML = `<span class="temp-badge ${tlvl}">${fmt(g.temp, 0)}°C</span>`;
  } else {
    $('gpu-temp-val').textContent = '—';
  }
  $('gpu-power').textContent = g.power != null ? `${g.power.toFixed(1)} W` : '';

  // VRAM
  if (g.mem_total_gb && g.mem_used_gb != null) {
    const pct = (g.mem_used_gb / g.mem_total_gb) * 100;
    $('vram-pct').textContent = pct.toFixed(1) + '%';
    $('vram-info').textContent =
      `${g.mem_used_gb} GB / ${g.mem_total_gb} GB (Frei: ${(g.mem_total_gb - g.mem_used_gb).toFixed(1)} GB)`;
    setBar('vram-bar', pct, pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok');
  } else if (g.mem_total_gb) {
    $('vram-pct').textContent = '—';
    $('vram-info').textContent = `Gesamt: ${g.mem_total_gb} GB`;
  } else {
    $('vram-pct').textContent = '—';
    $('vram-info').textContent = 'Keine VRAM-Daten';
  }
  const sparkHost = $('gpu-spark');
  if (sparkHost) sparkHost.innerHTML = sparkline('gpu_load', { min: 0, max: 100, cls: 'accent' });
}

function renderPsu(d) {
  const psu = d.psu;
  if (!psu || psu.total_w == null) {
    $('psu-total').textContent = '—';
    $('psu-name').textContent  = 'Kein PSU erkannt';
    $('psu-bar') && ($('psu-bar').style.width = '0%');
    $('psu-efficiency-box') && ($('psu-efficiency-box').style.display = 'none');
    return;
  }
  const maxW = State.config?.psu_max_watts || 1000;
  const pct  = Math.min((psu.total_w / maxW) * 100, 100);
  const lvl = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : 'ok';
  $('psu-total').textContent = Math.round(psu.total_w) + ' W';
  $('psu-name').textContent  = psu.name || 'PSU';
  setBar('psu-bar', pct, lvl);

  if (psu.efficiency != null && $('psu-efficiency-box')) {
    $('psu-efficiency-box').style.display = '';
    $('psu-efficiency').textContent = Math.round(psu.efficiency);
  }
  const railFmt = (v, dec = 1) => v != null ? Number(v).toFixed(dec) : '—';
  $('psu-12v-w').textContent   = railFmt(psu['12v_w'], 0);
  $('psu-12v-v').textContent   = railFmt(psu['12v_v']);
  $('psu-12v-a').textContent   = railFmt(psu['12v_a']);
  $('psu-5v-w').textContent    = railFmt(psu['5v_w'], 0);
  $('psu-5v-v').textContent    = railFmt(psu['5v_v']);
  $('psu-5v-a').textContent    = railFmt(psu['5v_a']);
  $('psu-33v-w').textContent   = railFmt(psu['33v_w'], 0);
  $('psu-33v-v').textContent   = railFmt(psu['33v_v']);
  $('psu-33v-a').textContent   = railFmt(psu['33v_a']);
  $('psu-input-w').textContent = railFmt(psu.input_w, 0);
  $('psu-input-v').textContent = railFmt(psu.input_v, 0);
  $('psu-temp-vrm').textContent  = railFmt(psu.temp_vrm);
  $('psu-temp-case').textContent = railFmt(psu.temp_case);
  $('psu-fan').textContent     = psu.fan_rpm != null ? Math.round(psu.fan_rpm) : '—';
}

function renderAio(d) {
  const aio = d.aio;
  if (!aio) {
    $('aio-temp').textContent = '—';
    $('aio-name').textContent = 'Kein AIO erkannt';
    ['aio-pump-rpm','aio-pump-duty','aio-fan1-rpm','aio-fan1-duty','aio-fan2-rpm','aio-fan2-duty']
      .forEach(id => $(id) && ($(id).textContent = '—'));
    return;
  }
  $('aio-temp').textContent = aio.liquid_temp != null ? Number(aio.liquid_temp).toFixed(1) + ' °C' : '—';
  $('aio-name').textContent = aio.name || 'AIO';
  const fmtI = (v) => v != null ? Math.round(v) : '—';
  $('aio-pump-rpm').textContent  = fmtI(aio.pump_rpm);
  $('aio-pump-duty').textContent = fmtI(aio.pump_duty);
  $('aio-fan1-rpm').textContent  = fmtI(aio.fan1_rpm);
  $('aio-fan1-duty').textContent = fmtI(aio.fan1_duty);
  $('aio-fan2-rpm').textContent  = fmtI(aio.fan2_rpm);
  $('aio-fan2-duty').textContent = fmtI(aio.fan2_duty);
}

function renderProcs(d) {
  const tbody = $('proc-body');
  if (!tbody || !d.processes) return;
  tbody.innerHTML = d.processes.slice(0, 10).map(p => {
    const cl = p.cpu >= 80 ? 'danger' : p.cpu >= 50 ? 'warn' : p.cpu >= 10 ? 'ok' : 'idle';
    return `<tr>
      <td class="proc-name">${escHtml(p.name)}</td>
      <td class="proc-pid">${p.pid}</td>
      <td class="proc-cpu ${cl}">${p.cpu.toFixed(1)}</td>
      <td>${p.ram_mb}</td>
    </tr>`;
  }).join('');
}

function renderSystemInfo() {
  if (!State.systemInfo) return;
  const s = State.systemInfo;
  const el = $('system-info');
  if (!el) return;
  el.innerHTML = `
    <div class="sys-row"><span>OS</span><b>${escHtml(s.os)} ${escHtml(s.os_release)}</b></div>
    <div class="sys-row"><span>Architektur</span><b>${escHtml(s.arch)}</b></div>
    <div class="sys-row"><span>CPU</span><b>${escHtml(s.cpu_model)}</b></div>
    <div class="sys-row"><span>Kerne / Threads</span><b>${s.cpu_cores} / ${s.cpu_threads}</b></div>
    <div class="sys-row"><span>RAM</span><b>${s.ram_total_gb} GB</b></div>
    <div class="sys-row"><span>Python</span><b>${escHtml(s.python)}</b></div>`;
}

// ── Plugins ──────────────────────────────────────────────────────────────
const PLUGIN_INTERVAL_S_DEFAULT = 15;
const PLUGIN_INTERVAL_S_MIN = 1;
let _pluginsCache = { list: null, lastFetch: 0, outputs: {}, lastRun: {} };

function pluginIntervalSeconds(plugin) {
  const raw = plugin?.interval_s ?? PLUGIN_INTERVAL_S_DEFAULT;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return PLUGIN_INTERVAL_S_DEFAULT;
  return Math.max(seconds, PLUGIN_INTERVAL_S_MIN);
}

function fmtPluginInterval(plugin) {
  const seconds = pluginIntervalSeconds(plugin);
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function getAdminToken() {
  // settings.js legt das Token nach Login in sessionStorage ab.
  return sessionStorage.getItem('admin_token') || '';
}

async function renderPlugins() {
  const card = document.querySelector('[data-card-id="plugins"]');
  if (!card || card.style.display === 'none') return;
  const list   = $('plugins-list');
  const status = $('plugins-status');
  const token  = getAdminToken();

  if (!token) {
    status && (status.textContent = '');
    list.innerHTML = `<div class="plugins-empty">
      Plugin-Ausgaben benötigen Login.<br>
      <a href="/settings" class="plugins-link">Im Admin-Bereich anmelden →</a>
    </div>`;
    return;
  }

  // Plugin-Liste höchstens alle 30 s neu holen.
  const now = Date.now();
  if (!_pluginsCache.list || now - _pluginsCache.lastFetch > 30000) {
    try {
      const r = await fetch(`${API_BASE}/api/plugins`, {
        headers: { 'X-Auth-Token': token }, cache: 'no-store',
      });
      if (r.status === 401) {
        sessionStorage.removeItem('admin_token');
        status && (status.textContent = 'Token ungültig');
        list.innerHTML = `<div class="plugins-empty">
          Session abgelaufen. <a href="/settings" class="plugins-link">Neu anmelden →</a>
        </div>`;
        return;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _pluginsCache.list = await r.json();
      _pluginsCache.lastFetch = now;
    } catch (e) {
      status && (status.textContent = 'Fehler');
      list.innerHTML = `<div class="plugins-empty">Plugins konnten nicht geladen werden: ${escHtml(e.message)}</div>`;
      return;
    }
  }

  const plugins = _pluginsCache.list || [];
  if (plugins.length === 0) {
    status && (status.textContent = '');
    list.innerHTML = `<div class="plugins-empty">
      Keine Plugins konfiguriert.<br>
      <a href="/settings" class="plugins-link">Unter /settings anlegen →</a>
    </div>`;
    return;
  }

  // Jedes Plugin wird nur nach seinem eigenen Intervall neu ausgeführt.
  const runs = await Promise.all(plugins.map(async (p) => {
    const last = _pluginsCache.lastRun[p.id] || 0;
    const intervalMs = pluginIntervalSeconds(p) * 1000;
    if (now - last < intervalMs && _pluginsCache.outputs[p.id]) {
      return { plugin: p, result: _pluginsCache.outputs[p.id] };
    }
    try {
      const r = await fetch(`${API_BASE}/api/plugin/${encodeURIComponent(p.id)}`, {
        headers: { 'X-Auth-Token': token }, cache: 'no-store',
      });
      const data = await r.json();
      _pluginsCache.outputs[p.id] = data;
      _pluginsCache.lastRun[p.id] = now;
      return { plugin: p, result: data };
    } catch (e) {
      return { plugin: p, result: { error: e.message } };
    }
  }));

  status && (status.textContent = `${plugins.length} aktiv`);
  list.innerHTML = runs.map(({ plugin, result }) => {
    const err = result?.error;
    const out = (result?.output ?? '').trim();
    const cls = err ? 'danger' : (out ? 'ok' : 'muted');
    const body = err
      ? `<pre class="plugin-output error">${escHtml(err)}</pre>`
      : `<pre class="plugin-output">${escHtml(out || '(Keine Ausgabe)')}</pre>`;
    return `
      <div class="plugin-item ${cls}">
        <div class="plugin-item-head">
          <span class="plugin-item-label">${escHtml(plugin.label || plugin.id)}</span>
          <span class="plugin-type-badge">${escHtml(plugin.type || 'shell')} / ${fmtPluginInterval(plugin)}</span>
        </div>
        ${body}
      </div>`;
  }).join('');
}

// ── Master-Render ────────────────────────────────────────────────────────
function render(d) {
  if (d.warming_up) {
    $('refresh-note').textContent = 'Sammle erste Messwerte …';
    return;
  }
  // History befüllen
  if (d.cpu?.percent != null)            pushHistory('cpu', d.cpu.percent);
  if (d.ram?.percent != null)            pushHistory('ram', d.ram.percent);
  if (d.disk?.read_mbps != null)         pushHistory('disk_read', d.disk.read_mbps);
  if (d.network?.total_dl_kbps != null)  pushHistory('net_dl', d.network.total_dl_kbps);
  if (d.gpu?.load != null)               pushHistory('gpu_load', d.gpu.load);

  renderTopbar(d);
  renderCpu(d);
  renderRam(d);
  renderDisks(d);
  renderNetwork(d);
  renderBattery(d);
  renderGpu(d);
  renderPsu(d);
  renderAio(d);
  renderProcs(d);
  renderPlugins();   // Plugin-Ausgaben (eigene Call-Kette, asynchron)

  // Connection-Status
  document.querySelector('.status-dot')?.classList.replace('offline', 'online');
  $('refresh-note').textContent = `Aktualisiert alle ${State.refreshMs / 1000} s`;
}

// ── Polling mit Backoff ──────────────────────────────────────────────────
async function poll() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    render(data);
    State.errorCount = 0;
    scheduleNextPoll(State.refreshMs);
  } catch (e) {
    State.errorCount++;
    document.querySelector('.status-dot')?.classList.replace('online', 'offline');
    const wait = Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.min(State.errorCount, 5));
    $('refresh-note').textContent =
      `Verbindungsfehler — neuer Versuch in ${wait / 1000} s [${e.message}]`;
    console.warn('[SysMon] poll error:', e);
    scheduleNextPoll(wait);
  }
}

function scheduleNextPoll(ms) {
  if (State.pollTimer) clearTimeout(State.pollTimer);
  State.pollTimer = setTimeout(poll, ms);
}

// ── Config laden + System-Info ───────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
    State.config = await res.json();
  } catch {
    State.config = { title: 'System Monitor', refresh_ms: 3000, cards: [] };
  }
  applyConfig();
  // Edit-Layer (index.html) signalisieren, dass die Config bereit ist.
  document.dispatchEvent(new CustomEvent('sysmon:config'));
}

async function loadSystemInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/system`, { cache: 'no-store' });
    State.systemInfo = await res.json();
    renderSystemInfo();
  } catch (e) {
    console.warn('Konnte System-Info nicht laden:', e);
  }
}

function applyConfig() {
  const cfg = State.config;
  if (!cfg) return;
  if (cfg.title) {
    document.title = cfg.title;
    document.querySelector('.logo-text') && (document.querySelector('.logo-text').textContent = cfg.title);
  }
  State.refreshMs = Math.max(POLL_MIN_MS, parseInt(cfg.refresh_ms) || 3000);

  // Kachelauswahl und -Reihenfolge anwenden
  const cards = [...(cfg.cards || [])].sort((a, b) => a.order - b.order);
  cards.forEach(c => {
    const el = document.querySelector(`[data-card-id="${c.id}"]`);
    if (!el) return;
    el.style.display = c.enabled ? '' : 'none';
    el.style.order = c.order;
  });
}

// ── Settings-Panel ───────────────────────────────────────────────────────
function openSettings() {
  const panel = $('settings-panel');
  const overlay = $('settings-overlay');
  if (!panel) return;
  const cfg = State.config;
  if (cfg) {
    $('cfg-title')   && ($('cfg-title').value   = cfg.title || 'System Monitor');
    $('cfg-refresh') && ($('cfg-refresh').value = cfg.refresh_ms || 3000);

    const list = $('settings-card-list');
    if (list) {
      list.innerHTML = '';
      [...(cfg.cards || [])].sort((a, b) => a.order - b.order).forEach(c => {
        const li = document.createElement('li');
        li.className = 'settings-card-item';
        li.dataset.id = c.id;
        li.draggable = true;
        li.innerHTML = `
          <span class="drag-handle">⋮⋮</span>
          <span class="card-item-label">${escHtml(c.label)}</span>
          <label class="toggle-switch">
            <input type="checkbox" ${c.enabled ? 'checked' : ''} data-card-toggle="${c.id}">
            <span class="toggle-slider"></span>
          </label>`;
        list.appendChild(li);
      });
      initDragDrop(list);
    }
  }
  panel.classList.add('open');
  overlay.classList.add('open');
}

function closeSettings() {
  $('settings-panel')?.classList.remove('open');
  $('settings-overlay')?.classList.remove('open');
}

// Schreibt die aktuelle State.config ins Backend (config.json).
// Sendet den Admin-Token mit — sonst lehnt das Backend (X-Auth-Token) ab.
async function persistConfig() {
  const token = getAdminToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth-Token'] = token;
  const res = await fetch(`${API_BASE}/api/config`, {
    method: 'POST',
    headers,
    body: JSON.stringify(State.config),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.error || j.detail || detail; } catch {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function saveSettings() {
  if (!State.config) return;
  State.config.title      = $('cfg-title')?.value   || State.config.title;
  State.config.refresh_ms = parseInt($('cfg-refresh')?.value) || State.config.refresh_ms;

  const list = $('settings-card-list');
  list?.querySelectorAll('.settings-card-item').forEach((item, idx) => {
    const id  = item.dataset.id;
    const chk = item.querySelector(`[data-card-toggle="${id}"]`);
    const c   = State.config.cards.find(c => c.id === id);
    if (c) {
      c.order = idx;
      c.enabled = chk ? chk.checked : c.enabled;
    }
  });

  const status = $('settings-status');
  try {
    const data = await persistConfig();
    if (data.ok) {
      if (status) { status.textContent = '✓ Gespeichert'; setTimeout(() => status.textContent = '', 1800); }
      applyConfig();
      closeSettings();
    } else if (status) {
      status.textContent = data.error || 'Fehler beim Speichern.';
    }
  } catch (e) {
    if (status) {
      status.textContent = e.status === 401 || e.status === 503
        ? 'Nicht angemeldet — bitte im Admin-Bereich (/settings) anmelden.'
        : 'Server nicht erreichbar.';
    }
  }
}

function initDragDrop(list) {
  let dragging = null;
  list.addEventListener('dragstart', e => {
    dragging = e.target.closest('.settings-card-item');
    setTimeout(() => dragging?.classList.add('dragging'), 0);
  });
  list.addEventListener('dragend', () => {
    dragging?.classList.remove('dragging');
    dragging = null;
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.settings-card-item');
    if (!target || target === dragging) return;
    const rect = target.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    list.insertBefore(dragging, e.clientY < mid ? target : target.nextSibling);
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('settings-btn')    ?.addEventListener('click', openSettings);
  $('settings-close')  ?.addEventListener('click', closeSettings);
  $('settings-overlay')?.addEventListener('click', closeSettings);
  $('settings-save')   ?.addEventListener('click', saveSettings);
});

// Schnittstelle für den Edit-Layer (Inline-Script in index.html):
// dieser liest/schreibt das Layout (Größe, Reihenfolge, Sichtbarkeit) jetzt
// serverseitig in config.json statt im localStorage.
window.SysMon = {
  getConfig: () => State.config,
  persistConfig,
  applyConfig,
  getAdminToken,
};

loadConfig();
loadSystemInfo();
scheduleNextPoll(500);   // erster Poll mit kurzer Anlaufzeit
