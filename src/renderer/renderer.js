// `api` is the global exposed by preload.js.
const $ =(sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABEL = {
  stopped: 'Stopped',
  waiting: 'Waiting',
  starting: 'Starting',
  running: 'Running',
  ready: 'Ready',
  stopping: 'Stopping',
  error: 'Error',
};
const ACTIVE = new Set(['waiting', 'starting', 'running', 'ready', 'stopping']);

let services = [];
let docker = { enabled: true, available: null, containers: [], starting: false };
let selected = null; // { kind: 'service' | 'container', id }
const dockerBusy = new Set();
let collapsed = new Set();
try {
  collapsed = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));
} catch {}

// ---- terminal ---------------------------------------------------------------

const term = new Terminal({
  convertEol: true,
  disableStdin: true,
  scrollback: 10000,
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  theme: { background: '#05040d', foreground: '#ece9ff' },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($('#terminal'));
new ResizeObserver(() => {
  try {
    fitAddon.fit();
  } catch {}
}).observe($('#terminal'));

async function loadTerminal() {
  const target = selected;
  term.reset();
  if (!target) return;
  const text =
    target.kind === 'service' ? await api.invoke('log:get', target.id) : await api.invoke('docker:logs', target.id);
  if (selected !== target) return;
  term.reset();
  term.write(text || '\x1b[90m(no output yet)\x1b[0m\r\n');
}

// ---- helpers ------------------------------------------------------------------

const SVG = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>',
  restart: SVG('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>'),
  open: SVG('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  copy: SVG('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  bolt: SVG('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  trash: SVG('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
};

const iconBtn = (action, icon, label, extra = '') =>
  `<button class="icon-btn" data-action="${action}" aria-label="${label}" ${extra}>${icon}</button>`;
// Big dock button in the detail header.
const dockBtn = (action, icon, label, cls = '', extra = '') =>
  `<button class="ab ${cls}" data-action="${action}" aria-label="${label}" ${extra}>${icon}</button>`;
const tag = (html, cls = '') => `<span class="tag ${cls}">${html}</span>`;
const linkTag = (url) => `<a href="#" class="tag" data-action="open-url" data-url="${esc(url)}">↗ ${esc(url)}</a>`;

function localUrl(s) {
  if (s.type !== 'process' || !s.port || s.url) return null;
  return `http://localhost:${s.port}`;
}

function serviceMeta(s) {
  if (s.status === 'error') return s.message;
  if (s.url) return s.url.replace(/^https?:\/\//, '');
  if (s.type === 'ollama') return s.message || s.model;
  if (s.port) return `localhost:${s.port}`;
  return STATUS_LABEL[s.status];
}

function canStart(s) {
  return !ACTIVE.has(s.status) || (s.type === 'ollama' && s.status === 'running');
}

function isSelected(kind, id) {
  return selected && selected.kind === kind && selected.id === id;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), isError ? 6000 : 2500);
}

// ---- render: services ---------------------------------------------------------

function renderServices() {
  $('#serviceList').innerHTML = services
    .map((s) => {
      const actions = [
        canStart(s) ? iconBtn('start', ICON.play, 'Start') : '',
        ACTIVE.has(s.status) && s.status !== 'stopping'
          ? iconBtn('restart', ICON.restart, 'Restart') + iconBtn('stop', ICON.stop, 'Stop')
          : '',
      ].join('');
      return `
        <div class="item ${isSelected('service', s.id) ? 'selected' : ''}" data-kind="service" data-id="${esc(s.id)}">
          <span class="dot ${s.status}" title="${STATUS_LABEL[s.status]}"></span>
          <div class="item-main">
            <div class="item-name">${esc(s.name)}</div>
            <div class="item-meta ${s.status === 'error' ? 'err' : ''}">${esc(serviceMeta(s))}</div>
          </div>
          <div class="item-actions">${actions}</div>
        </div>`;
    })
    .join('');
  const ready = services.filter((s) => s.status === 'ready').length;
  const running = docker.containers.filter((c) => c.state === 'running').length;
  $('#sReady').textContent = `${ready}/${services.length}`;
  $('#sBar').style.width = `${services.length ? (ready / services.length) * 100 : 0}%`;
  $('#sDockChip').classList.toggle('hidden', !docker.available);
  $('#sDock').textContent = running;
}

// ---- render: docker -----------------------------------------------------------

function containerRow(c, nested) {
  const running = c.state === 'running';
  const busy = dockerBusy.has(c.id);
  const action = busy
    ? '<span class="spinner"></span>'
    : running
      ? iconBtn('docker-stop', ICON.stop, 'Stop')
      : iconBtn('docker-start', ICON.play, 'Start');
  return `
    <div class="item ${nested ? 'nested' : ''} ${isSelected('container', c.id) ? 'selected' : ''}" data-kind="container" data-id="${esc(c.id)}">
      <span class="dot ${busy ? 'starting' : running ? 'ready' : 'stopped'}" title="${esc(c.status)}"></span>
      <div class="item-main">
        <div class="item-name">${esc(c.name)}</div>
        <div class="item-meta">${esc(c.ports || c.image)}</div>
      </div>
      <div class="item-actions">${action}</div>
    </div>`;
}

function renderDocker() {
  const el = $('#dockerList');
  if (!docker.enabled) {
    el.innerHTML = '<div class="muted pad">Disabled in settings</div>';
    return;
  }
  if (docker.available === null) {
    el.innerHTML = '<div class="muted pad">Checking Docker…</div>';
    return;
  }
  if (!docker.available) {
    el.innerHTML = `
      <div class="docker-off">
        <span class="muted">Docker Engine is not running</span>
        <button class="btn small" data-action="docker-desktop" ${docker.starting ? 'disabled' : ''}>
          ${docker.starting ? 'Starting Docker Desktop…' : 'Start Docker Desktop'}
        </button>
      </div>`;
    return;
  }
  if (!docker.containers.length) {
    el.innerHTML = '<div class="muted pad">No containers</div>';
    return;
  }

  const groups = new Map();
  for (const c of docker.containers) {
    if (!groups.has(c.project)) groups.set(c.project, []);
    groups.get(c.project).push(c);
  }
  const standalone = groups.get('') || [];
  const projects = [...groups.keys()].filter(Boolean).sort();

  let html = standalone.map((c) => containerRow(c, false)).join('');
  for (const project of projects) {
    const list = groups.get(project);
    const running = list.filter((c) => c.state === 'running').length;
    const busy = dockerBusy.has(`group:${project}`);
    const dot = running === 0 ? 'stopped' : running === list.length ? 'ready' : 'partial';
    const action = busy
      ? '<span class="spinner"></span>'
      : (running < list.length ? iconBtn('docker-start', ICON.play, 'Start all in group') : '') +
        (running > 0 ? iconBtn('docker-stop', ICON.stop, 'Stop all in group') : '');
    const open = !collapsed.has(project);
    html += `
      <div class="item" data-kind="group" data-id="${esc(project)}">
        <span class="caret">${open ? '▾' : '▸'}</span>
        <span class="dot ${busy ? 'starting' : dot}"></span>
        <div class="item-main">
          <div class="item-name">${esc(project)}</div>
          <div class="item-meta">compose · ${running}/${list.length} running</div>
        </div>
        <div class="item-actions">${action}</div>
      </div>`;
    if (open) html += list.map((c) => containerRow(c, true)).join('');
  }
  el.innerHTML = html;
}

// ---- render: detail -----------------------------------------------------------

function renderDetail() {
  const h = $('#detailHeader');
  const termTitle = $('#termTitle');
  if (!selected) {
    h.innerHTML = '<div class="muted">Select a service or container</div>';
    termTitle.textContent = '';
    return;
  }

  if (selected.kind === 'service') {
    const s = services.find((x) => x.id === selected.id);
    if (!s) return;
    const active = ACTIVE.has(s.status);
    const local = localUrl(s);
    const openUrl = s.url || local;
    const info = [];
    if (s.type === 'ollama') {
      info.push(tag(`Model ${esc(s.model)}`));
      if (s.port) info.push(tag(`API http://localhost:${s.port}`, 'path'));
    } else {
      info.push(tag(`$ ${esc(s.command)}`));
      info.push(tag(esc(s.cwd), 'path'));
    }
    if (local) info.push(linkTag(local));
    if (s.url) info.push(linkTag(s.url));
    if (s.pid) info.push(tag(`PID ${s.pid}`, 'path'));
    if (s.message) info.push(tag(esc(s.message), s.status === 'error' ? 'err' : 'path'));

    const main =
      canStart(s) ? dockBtn('start', ICON.play, 'Start', 'pri go')
      : active && s.status !== 'stopping' ? dockBtn('stop', ICON.stop, 'Stop', 'pri stop')
      : '';
    h.innerHTML = `
      <div class="dh-row">
        <span class="dot ${s.status}"></span>
        <h1>${esc(s.name)}</h1>
        <span class="badge ${s.status}">${STATUS_LABEL[s.status]}</span>
        ${s.external ? '<span class="badge" title="Started outside Dev Launcher">external</span>' : ''}
      </div>
      <div class="dh-info">${info.join('')}</div>
      <div class="dock" role="toolbar">
        ${main}
        ${dockBtn('restart', ICON.restart, 'Restart', '', active && s.status !== 'stopping' ? '' : 'disabled')}
        ${dockBtn('open-url', ICON.open, 'Open in browser', '', openUrl ? `data-url="${esc(openUrl)}"` : 'disabled')}
        ${dockBtn('open-folder', ICON.folder, 'Open folder', '', s.cwd ? `data-path="${esc(s.cwd)}"` : 'disabled')}
        ${s.url ? dockBtn('copy', ICON.copy, 'Copy URL', '', `data-url="${esc(s.url)}"`) : ''}
        <span class="dock-sep"></span>
        ${s.type !== 'ollama' ? dockBtn('kill-leftovers', ICON.bolt, 'Kill leftover processes', 'danger', active ? 'disabled' : '') : ''}
        ${dockBtn('clear-log', ICON.trash, 'Clear log', 'danger')}
      </div>`;
    termTitle.textContent = `${s.command || s.name} — ${active ? 'live' : 'idle'}`;
    return;
  }

  const c = docker.containers.find((x) => x.id === selected.id);
  if (!c) {
    h.innerHTML = '<div class="muted">Container not found</div>';
    termTitle.textContent = '';
    return;
  }
  const running = c.state === 'running';
  const busy = dockerBusy.has(c.id);
  const info = [tag(`Image ${esc(c.image)}`), tag(esc(c.status), 'path')];
  if (c.ports) info.push(tag(`Ports ${esc(c.ports)}`));
  if (c.project) info.push(tag(`Compose ${esc(c.project)}`, 'path'));
  h.innerHTML = `
    <div class="dh-row">
      <span class="dot ${busy ? 'starting' : running ? 'ready' : 'stopped'}"></span>
      <h1>${esc(c.name)}</h1>
      <span class="badge ${running ? 'ready' : ''}">${esc(c.state)}</span>
    </div>
    <div class="dh-info">${info.join('')}</div>
    <div class="dock" role="toolbar">
      ${busy ? '' : running ? dockBtn('docker-stop', ICON.stop, 'Stop', 'pri stop') : dockBtn('docker-start', ICON.play, 'Start', 'pri go')}
      ${dockBtn('docker-logs', ICON.restart, 'Reload logs')}
    </div>`;
  termTitle.textContent = `${c.name} — ${running ? 'live' : 'idle'}`;
}

function renderAll() {
  renderServices();
  renderDocker();
  renderDetail();
}

function select(kind, id) {
  selected = { kind, id };
  renderAll();
  loadTerminal();
}

// ---- docker -------------------------------------------------------------------

let refreshing = false;
async function refreshDocker() {
  if (refreshing) return;
  refreshing = true;
  try {
    const res = await api.invoke('docker:list');
    docker = { ...docker, ...res, starting: docker.starting && !res.available };
  } finally {
    refreshing = false;
  }
  renderServices();
  renderDocker();
  if (selected?.kind === 'container') renderDetail();
}

async function dockerAction(start, item) {
  let ids;
  let busyKey;
  if (item?.dataset.kind === 'group') {
    const project = item.dataset.id;
    ids = docker.containers
      .filter((c) => c.project === project && (start ? c.state !== 'running' : c.state === 'running'))
      .map((c) => c.id);
    busyKey = `group:${project}`;
  } else {
    const id = item?.dataset.kind === 'container' ? item.dataset.id : selected.id;
    ids = [id];
    busyKey = id;
  }
  if (!ids.length) return;
  dockerBusy.add(busyKey);
  renderAll();
  const res = await api.invoke(start ? 'docker:start' : 'docker:stop', ids);
  dockerBusy.delete(busyKey);
  if (!res.ok) toast(res.error, true);
  await refreshDocker();
  if (selected?.kind === 'container' && ids.includes(selected.id)) loadTerminal();
}

async function startDockerDesktop() {
  docker.starting = true;
  renderDocker();
  const res = await api.invoke('docker:startDesktop');
  docker.starting = false;
  if (!res.ok) toast(res.error, true);
  await refreshDocker();
}

// ---- events -------------------------------------------------------------------

async function handleAction(action, el, item) {
  const serviceId = item?.dataset.kind === 'service' ? item.dataset.id : selected?.id;
  switch (action) {
    case 'start':
    case 'stop':
    case 'restart':
      return api.invoke(`svc:${action}`, serviceId);
    case 'kill-leftovers': {
      const res = await api.invoke('svc:killLeftovers', serviceId);
      if (!res.ok) return toast(res.error, true);
      return toast(
        res.killed.length
          ? `Killed ${res.killed.map((p) => `${p.name} (${p.pid})`).join(', ')}`
          : 'No leftover processes found'
      );
    }
    case 'docker-start':
      return dockerAction(true, item);
    case 'docker-stop':
      return dockerAction(false, item);
    case 'docker-desktop':
      return startDockerDesktop();
    case 'docker-logs':
      return loadTerminal();
    case 'open-folder':
      return api.invoke('open:folder', el.dataset.path);
    case 'open-url':
      return api.invoke('open:url', el.dataset.url);
    case 'copy':
      await api.invoke('clipboard:write', el.dataset.url);
      return toast('Copied to clipboard');
    case 'clear-log':
      await api.invoke('log:clear', selected.id);
      return term.reset();
  }
}

$('.sidebar').addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  const button = e.target.closest('[data-action]');
  if (button) {
    e.preventDefault();
    handleAction(button.dataset.action, button, item);
    return;
  }
  if (!item) return;
  if (item.dataset.kind === 'group') {
    const id = item.dataset.id;
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    try {
      localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
    } catch {}
    renderDocker();
    return;
  }
  select(item.dataset.kind, item.dataset.id);
});

$('#detailHeader').addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  e.preventDefault();
  handleAction(button.dataset.action, button, null);
});

$('#btnStartAll').addEventListener('click', () => api.invoke('svc:startAll'));
$('#btnStopAll').addEventListener('click', () => api.invoke('svc:stopAll'));
$('#btnDockerRefresh').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.classList.remove('spin');
  void b.offsetWidth;
  b.classList.add('spin');
  refreshDocker();
});

// ---- tooltip, spotlight & ripple (event delegation; buttons are re-rendered) ----

const tip = $('#tip');
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest('.ab, .icon-btn');
  const label = el?.getAttribute('aria-label');
  if (!label) return;
  tip.textContent = label;
  const r = el.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(r.left + r.width / 2, 50), innerWidth - 50)}px`;
  tip.style.top = `${r.top - 36}px`;
  tip.classList.add('show');
});
document.addEventListener('pointerout', (e) => {
  if (e.target.closest('.ab, .icon-btn')) tip.classList.remove('show');
});
document.addEventListener('pointermove', (e) => {
  const b = e.target.closest('.fx');
  if (!b) return;
  const r = b.getBoundingClientRect();
  b.style.setProperty('--mx', `${e.clientX - r.left}px`);
  b.style.setProperty('--my', `${e.clientY - r.top}px`);
});
document.addEventListener('pointerdown', (e) => {
  tip.classList.remove('show');
  const b = e.target.closest('.fx, .ab');
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const p = document.createElement('span');
  p.className = 'ripple';
  p.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  b.appendChild(p);
  setTimeout(() => p.remove(), 650);
});

api.on('state', (snapshot) => {
  services = snapshot;
  if (selected?.kind === 'service' && !services.some((s) => s.id === selected.id)) {
    selected = services[0] ? { kind: 'service', id: services[0].id } : null;
    loadTerminal();
  }
  renderServices();
  if (selected?.kind === 'service') renderDetail();
});

api.on('log', ({ id, data }) => {
  if (selected?.kind === 'service' && selected.id === id) term.write(data);
});

// ---- settings -----------------------------------------------------------------

const settingsEl = $('#settings');
const cfgText = $('#cfgText');
const cfgError = $('#cfgError');

function syncToggles() {
  let cfg;
  try {
    cfg = JSON.parse(cfgText.value);
  } catch {
    return;
  }
  document.querySelectorAll('.toggles input').forEach((input) => {
    input.checked = !!cfg.settings?.[input.dataset.key];
  });
}

async function openSettings() {
  const { path, text } = await api.invoke('config:get');
  $('#cfgPath').textContent = path;
  cfgText.value = text;
  cfgError.textContent = '';
  syncToggles();
  settingsEl.classList.remove('hidden');
}

function closeSettings() {
  settingsEl.classList.add('hidden');
}

document.querySelectorAll('.toggles input').forEach((input) => {
  input.addEventListener('change', () => {
    try {
      const cfg = JSON.parse(cfgText.value);
      cfg.settings = { ...(cfg.settings || {}), [input.dataset.key]: input.checked };
      cfgText.value = JSON.stringify(cfg, null, 2);
      cfgError.textContent = '';
    } catch (err) {
      input.checked = !input.checked;
      cfgError.textContent = `Fix the JSON first: ${err.message}`;
    }
  });
});

cfgText.addEventListener('input', () => {
  try {
    JSON.parse(cfgText.value);
    cfgError.textContent = '';
    syncToggles();
  } catch (err) {
    cfgError.textContent = err.message;
  }
});

cfgText.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  cfgText.setRangeText('  ', cfgText.selectionStart, cfgText.selectionEnd, 'end');
});

$('#btnCfgSave').addEventListener('click', async () => {
  const res = await api.invoke('config:save', cfgText.value);
  if (!res.ok) {
    cfgError.textContent = res.error;
    return;
  }
  closeSettings();
  toast('Settings saved');
  refreshDocker();
});
$('#btnSettings').addEventListener('click', openSettings);
$('#btnCfgCancel').addEventListener('click', closeSettings);
$('#btnCfgClose').addEventListener('click', closeSettings);
$('#btnOpenCfg').addEventListener('click', () => api.invoke('config:openFile'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

// ---- init ---------------------------------------------------------------------

(async () => {
  services = await api.invoke('state:get');
  if (services[0]) selected = { kind: 'service', id: services[0].id };
  renderAll();
  loadTerminal();
  refreshDocker();
  setInterval(() => {
    if (!document.hidden) refreshDocker();
  }, 5000);
})();
