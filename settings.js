/* =========================================================
   settings.js — Admin-Bereich Logic für System Monitor
   ========================================================= */

const BASE = location.origin;
let AUTH_TOKEN = '';
let _plugins = [];
let _editingPlugin = null; // null = neu, string = id
const PLUGIN_INTERVAL_S_DEFAULT = 15;
const PLUGIN_INTERVAL_S_MIN = 1;

/* ── Hilfsfunktionen ─────────────────────────────────────── */
function apiHeaders() {
  return { 'Content-Type': 'application/json', 'X-Auth-Token': AUTH_TOKEN };
}

function toast(msg, type = 'success') {
  const el = document.getElementById('admin-toast');
  el.textContent = msg;
  el.className = `admin-toast ${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'admin-toast'; }, 3200);
}

function generateId() {
  return 'plugin_' + Math.random().toString(36).slice(2, 9);
}

function pluginIntervalSeconds(plugin) {
  const raw = plugin?.interval_s ?? PLUGIN_INTERVAL_S_DEFAULT;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return PLUGIN_INTERVAL_S_DEFAULT;
  return Math.max(seconds, PLUGIN_INTERVAL_S_MIN);
}

function formatPluginIntervalSeconds(seconds) {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/* ── Login ───────────────────────────────────────────────── */
const loginOverlay = document.getElementById('login-overlay');
const adminLayout  = document.getElementById('admin-layout');
const loginInput   = document.getElementById('login-token');
const loginBtn     = document.getElementById('login-btn');
const loginError   = document.getElementById('login-error');

async function tryLogin(token) {
  loginError.textContent = '';
  try {
    const res = await fetch(`${BASE}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      AUTH_TOKEN = token;
      sessionStorage.setItem('admin_token', token);
      loginOverlay.style.display = 'none';
      adminLayout.style.display = 'flex';
      initAdmin();
    } else {
      loginError.textContent = 'Falsches Token. Bitte erneut versuchen.';
      loginInput.focus();
    }
  } catch {
    loginError.textContent = 'Server nicht erreichbar.';
  }
}

loginBtn.addEventListener('click', () => tryLogin(loginInput.value.trim()));
loginInput.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });

// Auto-Login wenn Token in Session gespeichert
const saved = sessionStorage.getItem('admin_token');
if (saved) tryLogin(saved);
else loginInput.focus();

/* ── Logout ──────────────────────────────────────────────── */
document.getElementById('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem('admin_token');
  AUTH_TOKEN = '';
  adminLayout.style.display = 'none';
  loginOverlay.style.display = 'flex';
  loginInput.value = '';
  loginInput.focus();
});

/* ── Sidebar Navigation ──────────────────────────────────── */
const navItems = document.querySelectorAll('.nav-item[data-section]');
const sections = document.querySelectorAll('.admin-section');

function showSection(id) {
  sections.forEach(s => s.style.display = s.id === `section-${id}` ? '' : 'none');
  navItems.forEach(n => n.classList.toggle('active', n.dataset.section === id));
}

navItems.forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    showSection(item.dataset.section);
  });
});

/* ── Init after login ────────────────────────────────────── */
async function initAdmin() {
  showSection('dashboard');
  await loadConfig();
  await loadPlugins();
}

/* ── Config laden ────────────────────────────────────────── */
let _config = {};

async function loadConfig() {
  try {
    const res = await fetch(`${BASE}/api/config`);
    _config = await res.json();
    document.getElementById('cfg-title').value   = _config.title   || '';
    document.getElementById('cfg-refresh').value = _config.refresh_ms || 3000;
    renderCardList(_config.cards || []);
  } catch {
    toast('Konfiguration konnte nicht geladen werden.', 'error');
  }
}

/* ── Allgemein speichern ─────────────────────────────────── */
document.getElementById('save-general').addEventListener('click', async () => {
  const title      = document.getElementById('cfg-title').value.trim();
  const refresh_ms = parseInt(document.getElementById('cfg-refresh').value, 10);
  if (!title)          return toast('Titel darf nicht leer sein.', 'error');
  if (refresh_ms < 500) return toast('Intervall min. 500 ms.', 'error');

  _config.title      = title;
  _config.refresh_ms = refresh_ms;

  try {
    const res = await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(_config),
    });
    if (res.ok) toast('Allgemeine Einstellungen gespeichert.');
    else toast('Fehler beim Speichern.', 'error');
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
});

/* ── Kacheln (Drag & Drop) ───────────────────────────────── */
let _cards = [];
let _dragSrc = null;

function renderCardList(cards) {
  _cards = cards.slice();
  const list = document.getElementById('admin-card-list');
  list.innerHTML = '';

  _cards.forEach((card, i) => {
    const li = document.createElement('li');
    li.className = 'card-list-item';
    li.draggable = true;
    li.dataset.idx = i;

    const checkId = `toggle-${card.id}`;
    li.innerHTML = `
      <div class="drag-handle"><span></span><span></span><span></span></div>
      <span class="card-list-label">${card.label || card.id}</span>
      <label class="card-list-toggle" title="${card.enabled ? 'Sichtbar' : 'Ausgeblendet'}">
        <input type="checkbox" id="${checkId}" ${card.enabled ? 'checked' : ''} />
        <span class="toggle-track"></span>
        <span class="toggle-thumb"></span>
      </label>`;

    li.addEventListener('dragstart', e => {
      _dragSrc = i;
      li.style.opacity = '.45';
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => { li.style.opacity = ''; });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.card-list-item').forEach(el => el.classList.remove('drag-over'));
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (_dragSrc === null || _dragSrc === i) return;
      const moved = _cards.splice(_dragSrc, 1)[0];
      _cards.splice(i, 0, moved);
      renderCardList(_cards);
    });

    list.appendChild(li);
  });
}

document.getElementById('save-cards').addEventListener('click', async () => {
  // Reihenfolge + enabled-State aus dem DOM lesen
  const listItems = document.querySelectorAll('#admin-card-list .card-list-item');
  const updated = [];
  listItems.forEach((li, order) => {
    const idx   = parseInt(li.dataset.idx, 10);
    const card  = _cards[idx];
    const chk   = li.querySelector('input[type=checkbox]');
    updated.push({ ...card, order, enabled: chk ? chk.checked : true });
  });

  _config.cards = updated;
  try {
    const res = await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(_config),
    });
    if (res.ok) {
      toast('Kacheln gespeichert.');
      _cards = updated;
    } else {
      toast('Fehler beim Speichern.', 'error');
    }
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
});

document.getElementById('reset-cards').addEventListener('click', async () => {
  await loadConfig();
  toast('Zurückgesetzt.');
});

/* ── Plugins ─────────────────────────────────────────────── */
const PLUGIN_ICONS = {
  terminal: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  globe:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  cpu:      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>`,
  server:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`,
  activity: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
};

async function loadPlugins() {
  try {
    const res = await fetch(`${BASE}/api/plugins`, { headers: apiHeaders() });
    if (!res.ok) { toast('Plugins konnten nicht geladen werden.', 'error'); return; }
    _plugins = await res.json();
    renderPluginList();
  } catch {
    toast('Plugins-Endpunkt nicht erreichbar.', 'error');
  }
}

function renderPluginList() {
  const list  = document.getElementById('plugin-list');
  const empty = document.getElementById('plugin-empty');
  list.innerHTML = '';

  if (_plugins.length === 0) {
    list.appendChild(empty);
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  _plugins.forEach(p => {
    const item = document.createElement('div');
    item.className = 'plugin-item';
    const icon = PLUGIN_ICONS[p.icon] || PLUGIN_ICONS.terminal;
    const cmd  = p.type === 'shell' ? p.command : p.url;
    const interval = formatPluginIntervalSeconds(pluginIntervalSeconds(p));
    item.innerHTML = `
      <div class="plugin-item-icon">${icon}</div>
      <div class="plugin-item-info">
        <div class="plugin-item-label">${escapeHtml(p.label)}</div>
        <div class="plugin-item-cmd">${escapeHtml(cmd || '')}</div>
      </div>
      <span class="plugin-type-badge">${escapeHtml(p.type || 'shell')} / ${interval}</span>`;
    item.addEventListener('click', () => openEditor(p));
    list.appendChild(item);
  });
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Plugin Editor öffnen ───────────────────────────────── */
function openEditor(plugin = null) {
  _editingPlugin = plugin ? plugin.id : null;
  const editor   = document.getElementById('plugin-editor');
  const title    = document.getElementById('plugin-editor-title');
  const delBtn   = document.getElementById('delete-plugin-btn');
  const testArea = document.getElementById('plugin-test-area');
  const testOut  = document.getElementById('test-output');

  title.textContent = plugin ? 'Plugin bearbeiten' : 'Neues Plugin';
  delBtn.style.display  = plugin ? '' : 'none';
  testArea.style.display = plugin ? '' : 'none';
  testOut.textContent   = '—';

  document.getElementById('plg-label').value   = plugin?.label   || '';
  document.getElementById('plg-command').value = plugin?.command || '';
  document.getElementById('plg-url').value     = plugin?.url     || '';
  document.getElementById('plg-icon').value    = plugin?.icon    || 'terminal';
  document.getElementById('plg-interval').value = pluginIntervalSeconds(plugin);

  const type = plugin?.type || 'shell';
  document.querySelectorAll('[name="plg-type"]').forEach(r => r.checked = r.value === type);
  updateTypeFields(type);

  editor.style.display = '';
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateTypeFields(type) {
  document.getElementById('plg-shell-group').style.display = type === 'shell' ? '' : 'none';
  document.getElementById('plg-http-group').style.display  = type === 'http'  ? '' : 'none';
}

document.querySelectorAll('[name="plg-type"]').forEach(r => {
  r.addEventListener('change', () => updateTypeFields(r.value));
});

document.getElementById('add-plugin-btn').addEventListener('click', () => openEditor(null));
document.getElementById('cancel-plugin-btn').addEventListener('click', () => {
  document.getElementById('plugin-editor').style.display = 'none';
});

/* ── Plugin speichern ────────────────────────────────────── */
document.getElementById('save-plugin-btn').addEventListener('click', async () => {
  const label = document.getElementById('plg-label').value.trim();
  const type  = document.querySelector('[name="plg-type"]:checked')?.value || 'shell';
  const cmd   = document.getElementById('plg-command').value.trim();
  const url   = document.getElementById('plg-url').value.trim();
  const icon  = document.getElementById('plg-icon').value;
  const interval_s = Number(document.getElementById('plg-interval').value);

  if (!label) return toast('Bitte einen Label eingeben.', 'error');
  if (type === 'shell' && !cmd) return toast('Bitte einen Shell-Befehl eingeben.', 'error');
  if (type === 'http'  && !url) return toast('Bitte eine URL eingeben.', 'error');
  if (!Number.isFinite(interval_s) || interval_s < PLUGIN_INTERVAL_S_MIN) {
    return toast('Intervall min. 1 s.', 'error');
  }

  const pluginData = { label, type, icon, interval_s };
  if (type === 'shell') pluginData.command = cmd;
  else pluginData.url = url;

  if (_editingPlugin) {
    // Update
    const idx = _plugins.findIndex(p => p.id === _editingPlugin);
    if (idx >= 0) _plugins[idx] = { ..._plugins[idx], ...pluginData };
  } else {
    // Neu
    _plugins.push({ id: generateId(), ...pluginData });
  }

  await savePlugins();
});

/* ── Plugin löschen ──────────────────────────────────────── */
document.getElementById('delete-plugin-btn').addEventListener('click', async () => {
  if (!_editingPlugin) return;
  _plugins = _plugins.filter(p => p.id !== _editingPlugin);
  await savePlugins();
});

async function savePlugins() {
  try {
    const res = await fetch(`${BASE}/api/plugins`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(_plugins),
    });
    if (res.ok) {
      toast('Plugins gespeichert.');
      document.getElementById('plugin-editor').style.display = 'none';
      renderPluginList();
    } else {
      toast('Fehler beim Speichern.', 'error');
    }
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
}

/* ── Plugin testen ───────────────────────────────────────── */
document.getElementById('test-plugin-btn').addEventListener('click', async () => {
  if (!_editingPlugin) return;
  const out = document.getElementById('test-output');
  out.textContent = 'Läuft…';
  try {
    const res = await fetch(`${BASE}/api/plugin/${_editingPlugin}`, { headers: apiHeaders() });
    const data = await res.json();
    if (data.error) {
      out.textContent = `FEHLER:\n${data.error}`;
    } else {
      out.textContent = data.output || '(Keine Ausgabe)';
    }
  } catch (e) {
    out.textContent = `Verbindungsfehler: ${e.message}`;
  }
});

/* ── Sicherheit — Token ändern ───────────────────────────── */
document.getElementById('toggle-token-vis').addEventListener('click', () => {
  const f1 = document.getElementById('new-token');
  const f2 = document.getElementById('new-token-confirm');
  const vis = f1.type === 'text';
  f1.type = f2.type = vis ? 'password' : 'text';
});

document.getElementById('save-token-btn').addEventListener('click', async () => {
  const t1 = document.getElementById('new-token').value.trim();
  const t2 = document.getElementById('new-token-confirm').value.trim();
  if (!t1 || t1.length < 6) return toast('Token muss mindestens 6 Zeichen haben.', 'error');
  if (t1 !== t2)            return toast('Tokens stimmen nicht überein.', 'error');

  try {
    const res = await fetch(`${BASE}/api/auth/change-token`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ token: t1 }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      toast('Token geändert. Du wirst abgemeldet.');
      sessionStorage.removeItem('admin_token');
      setTimeout(() => {
        AUTH_TOKEN = '';
        adminLayout.style.display = 'none';
        loginOverlay.style.display = 'flex';
        loginInput.value = '';
        loginInput.focus();
      }, 1800);
    } else {
      toast(data.error || 'Fehler beim Ändern.', 'error');
    }
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
});

/* ── Netzwerk-Checklist ──────────────────────────────────── */
let _ifaceData = []; // { name, ip, enabled }

async function loadInterfaces() {
  const hint     = document.getElementById('net-filter-hint');
  const list     = document.getElementById('net-iface-checklist');
  if (!list) return;

  try {
    const res = await fetch(`${BASE}/api/interfaces`, { headers: apiHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _ifaceData = await res.json();
    renderIfaceList();
    if (hint) hint.classList.add('hidden');
  } catch (e) {
    if (hint) hint.textContent = 'Interfaces konnten nicht geladen werden: ' + e.message;
  }
}

function renderIfaceList() {
  const list = document.getElementById('net-iface-checklist');
  if (!list) return;
  list.innerHTML = '';

  if (_ifaceData.length === 0) {
    list.innerHTML = '<li style="color:var(--text-2);font-size:13px;padding:8px 0">Keine aktiven Interfaces gefunden.</li>';
    return;
  }

  _ifaceData.forEach((ifc, i) => {
    const li = document.createElement('li');
    li.className = 'net-iface-item' + (ifc.enabled ? ' checked' : '');
    li.dataset.idx = i;
    li.innerHTML = `
      <div class="net-iface-check">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="net-iface-info">
        <div class="net-iface-iname">${ifc.name}</div>
        <div class="net-iface-iip">${ifc.ip}</div>
      </div>
      ${ifc.enabled ? '<span class="net-iface-badge">Aktiv</span>' : ''}
    `;
    li.addEventListener('click', () => {
      _ifaceData[i].enabled = !_ifaceData[i].enabled;
      renderIfaceList();
    });
    list.appendChild(li);
  });
}

// Netzwerk-Sektion laden wenn sie aufgerufen wird
const _origShowSection = typeof showSection === 'function' ? showSection : null;
document.querySelectorAll('.nav-item[data-section="network"]').forEach(item => {
  item.addEventListener('click', () => loadInterfaces());
});

/* ── Festplatten-Checklist ─────────────────────────────────────── */
let _diskData = []; // { mountpoint, label, device, fstype, total_gb, used_gb, free_gb, percent, enabled }

async function loadDisks() {
  const hint = document.getElementById('disk-filter-hint');
  const list = document.getElementById('disk-checklist');
  if (!list) return;

  try {
    const res = await fetch(`${BASE}/api/disks`, { headers: apiHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _diskData = await res.json();
    renderDiskList();
    if (hint) hint.classList.add('hidden');
  } catch (e) {
    if (hint) hint.textContent = 'Laufwerke konnten nicht geladen werden: ' + e.message;
  }
}

function renderDiskList() {
  const list = document.getElementById('disk-checklist');
  if (!list) return;
  list.innerHTML = '';

  if (_diskData.length === 0) {
    list.innerHTML = '<li style="color:var(--text-2);font-size:13px;padding:8px 0">Keine Laufwerke gefunden.</li>';
    return;
  }

  _diskData.forEach((disk, i) => {
    const li = document.createElement('li');
    li.className = 'net-iface-item' + (disk.enabled ? ' checked' : '');
    li.dataset.idx = i;
    const pctStr = disk.percent != null ? ` — ${disk.percent.toFixed(1)}%` : '';
    const sizeStr = disk.total_gb != null ? ` (${disk.total_gb} GB)` : '';
    li.innerHTML = `
      <div class="net-iface-check">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <div class="net-iface-info">
        <div class="net-iface-iname">${disk.label}</div>
        <div class="net-iface-iip">${disk.device || disk.mountpoint}${sizeStr}${pctStr}</div>
      </div>
      ${disk.enabled ? '<span class="net-iface-badge">Aktiv</span>' : ''}
    `;
    li.addEventListener('click', () => {
      _diskData[i].enabled = !_diskData[i].enabled;
      renderDiskList();
    });
    list.appendChild(li);
  });
}

// Festplatten-Sektion laden wenn aufgerufen
document.querySelectorAll('.nav-item[data-section="disks"]').forEach(item => {
  item.addEventListener('click', () => loadDisks());
});

// Alle auswählen
document.getElementById('select-all-disk-btn')?.addEventListener('click', () => {
  const allChecked = _diskData.every(d => d.enabled);
  _diskData.forEach(d => d.enabled = !allChecked);
  renderDiskList();
});

// Speichern
document.getElementById('save-disk-btn')?.addEventListener('click', async () => {
  const enabled = _diskData.filter(d => d.enabled).map(d => d.mountpoint);
  const allEnabled = enabled.length === _diskData.length;
  const disk_filter = allEnabled ? [] : enabled;

  try {
    const cfgRes = await fetch(`${BASE}/api/config`);
    const cfg = await cfgRes.json();
    cfg.disk_filter = disk_filter;
    const res = await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(cfg),
    });
    if (res.ok) {
      toast(allEnabled
        ? 'Alle Laufwerke aktiviert.'
        : `${enabled.length} Laufwerk(e) gespeichert.`);
    } else {
      toast('Fehler beim Speichern.', 'error');
    }
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
});

// Alle auswählen
document.getElementById('select-all-net-btn')?.addEventListener('click', () => {
  const allChecked = _ifaceData.every(i => i.enabled);
  _ifaceData.forEach(i => i.enabled = !allChecked);
  renderIfaceList();
});

// Speichern
document.getElementById('save-network-btn')?.addEventListener('click', async () => {
  // Leeres Array = alle anzeigen; sonst nur die enabled ones
  const enabled = _ifaceData.filter(i => i.enabled).map(i => i.name);
  const allEnabled = enabled.length === _ifaceData.length;
  const network_filter = allEnabled ? [] : enabled;

  try {
    const cfgRes = await fetch(`${BASE}/api/config`);
    const cfg = await cfgRes.json();
    cfg.network_filter = network_filter;
    const res = await fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(cfg),
    });
    if (res.ok) {
      toast(allEnabled
        ? 'Alle Interfaces aktiviert.'
        : `${enabled.length} Interface(s) gespeichert.`);
    } else {
      toast('Fehler beim Speichern.', 'error');
    }
  } catch {
    toast('Server nicht erreichbar.', 'error');
  }
});
