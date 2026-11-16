const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const { sleep, isPortOpen, waitFor, findPortOwner, findProcessesByName, findProcessById, killTree } = require('./ports');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
// Next.js prints this when another instance of the same app is already running.
const STALE_PID_HINT = /taskkill\s+\/PID\s+(\d+)/i;
const LOCAL_URL_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/;
const MAX_LOG_CHARS = 400000;
const ACTIVE = new Set(['waiting', 'starting', 'running', 'ready', 'stopping']);
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

class ServiceManager extends EventEmitter {
  constructor() {
    super();
    this.config = { settings: {}, services: [] };
    this.state = new Map();
    this.logs = new Map();
    this.procs = new Map();
    this.tokens = new Map();
    this.staleHints = new Map(); // service id -> PID of a leftover instance named in its output
    this.retried = new Set(); // service ids already auto-retried after killing a leftover
    // Replaced by main.js with a dialog; returns 'kill' | 'ignore' | 'cancel'.
    this.onPortConflict = async () => 'ignore';
  }

  setConfig(config) {
    this.config = config;
    for (const s of config.services) {
      if (!this.state.has(s.id)) this.state.set(s.id, { status: 'stopped', message: '', pid: null, port: null, url: null, external: false });
    }
    for (const id of [...this.state.keys()]) {
      if (!this.find(id)) {
        this.state.delete(id);
        this.logs.delete(id);
      }
    }
    this.emitState();
  }

  find(id) {
    return this.config.services.find((s) => s.id === id);
  }

  isActive(id) {
    return ACTIVE.has(this.state.get(id)?.status);
  }

  snapshot() {
    return this.config.services.map((s) => ({
      id: s.id,
      name: s.name || s.id,
      type: s.type || 'process',
      cwd: s.cwd || '',
      command: s.command || '',
      model: s.model || '',
      configuredPort: s.port || null,
      ...this.state.get(s.id),
    }));
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  setState(id, patch) {
    const cur = this.state.get(id);
    if (!cur) return;
    if (Object.keys(patch).every((k) => cur[k] === patch[k])) return;
    Object.assign(cur, patch);
    this.emitState();
  }

  getLog(id) {
    return this.logs.get(id) || '';
  }

  clearLog(id) {
    this.logs.set(id, '');
  }

  appendLog(id, text) {
    let buf = (this.logs.get(id) || '') + text;
    if (buf.length > MAX_LOG_CHARS) buf = buf.slice(buf.length - MAX_LOG_CHARS);
    this.logs.set(id, buf);
    this.emit('log', { id, data: text });
  }

  sys(id, msg) {
    this.appendLog(id, `\x1b[36m[launcher]\x1b[0m ${msg}\r\n`);
  }

  fail(id, err) {
    const message = String(err?.message || err);
    this.sys(id, `\x1b[31m${message}\x1b[0m`);
    this.setState(id, { status: 'error', message });
    this.emit('failed', { id, name: this.find(id)?.name || id, message });
  }

  async startAll() {
    const targets = this.config.services.filter((s) => s.autoStart !== false);
    await Promise.all(targets.map((s) => this.start(s.id)));
  }

  async stopAll() {
    await Promise.all(this.config.services.map((s) => this.stop(s.id)));
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  async waitReady(id, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const status = this.state.get(id)?.status;
      if (status === 'ready') return true;
      if (!ACTIVE.has(status)) return false;
      await sleep(500);
    }
    return false;
  }

  async start(id) {
    const s = this.find(id);
    if (!s) return;
    const status = this.state.get(id).status;
    // An Ollama server that is up without the model loaded shows as "running"; Start loads the model.
    const ollamaNeedsModel = s.type === 'ollama' && status === 'running';
    if (ACTIVE.has(status) && !ollamaNeedsModel) return;

    const token = {};
    this.tokens.set(id, token);
    const alive = () => this.tokens.get(id) === token && this.isActive(id);
    this.setState(id, { status: 'waiting', message: '', port: null, url: null });

    try {
      const timeoutMs = (this.config.settings.dependencyTimeoutSec || 90) * 1000;
      for (const dep of s.dependsOn || []) {
        if (!this.isActive(dep)) this.start(dep);
        this.sys(id, `waiting for "${dep}" to be ready...`);
        const ok = await this.waitReady(dep, timeoutMs);
        if (!alive()) return;
        if (!ok) throw new Error(`Dependency "${dep}" is not ready`);
      }
      for (const dep of s.startAfter || []) {
        if (!this.isActive(dep)) continue;
        this.sys(id, `waiting for "${dep}" to start first...`);
        if (!(await this.waitReady(dep, timeoutMs))) this.sys(id, `"${dep}" is not ready, starting anyway`);
        if (!alive()) return;
      }
      if (s.type === 'ollama') await this.startOllama(s, alive);
      else await this.startProcess(s, alive);
    } catch (err) {
      if (this.tokens.get(id) === token) this.fail(id, err);
    }
  }

  async stop(id) {
    const s = this.find(id);
    const st = this.state.get(id);
    if (!s || !st) return;
    this.tokens.delete(id);
    this.retried.delete(id);
    if (s.type === 'ollama') return this.stopOllama(s);

    const child = this.procs.get(id);
    if (!child) {
      if (st.status !== 'stopped') this.setState(id, { status: 'stopped', message: '' });
      return;
    }
    this.setState(id, { status: 'stopping' });
    this.sys(id, 'stopping...');
    await killTree(child.pid);
    await waitFor(() => this.procs.get(id) !== child, 8000, 200);
    if (this.procs.get(id) === child) {
      this.procs.delete(id);
      this.setState(id, { status: 'stopped', pid: null });
    }
  }

  // ---- generic process -------------------------------------------------

  // Ports this service needs free: its own port, plus the ngrok agent's local API port
  // (a leftover ngrok agent holds it and makes the new tunnel fail with ERR_NGROK_334).
  conflictPorts(s) {
    const ports = [];
    if (s.port) ports.push(Number(s.port));
    if (s.ngrokApi) {
      try {
        const apiPort = Number(new URL(s.ngrokApi).port);
        if (apiPort) ports.push(apiPort);
      } catch {
        // Invalid URL: nothing to free.
      }
    }
    return ports;
  }

  async resolvePortConflict(s, alive) {
    for (const port of this.conflictPorts(s)) {
      if (!(await isPortOpen(port))) continue;
      const owner = await findPortOwner(port);
      // Leftover instances (started outside the launcher) are killed automatically unless disabled in settings.
      const auto = this.config.settings.autoKillPortConflicts !== false && owner && owner.pid !== process.pid;
      const choice = auto ? 'kill' : await this.onPortConflict({ service: s, port, owner });
      if (!alive()) return false;
      if (choice === 'cancel') {
        this.sys(s.id, 'start cancelled: port in use');
        this.setState(s.id, { status: 'stopped' });
        return false;
      }
      if (choice === 'kill' && owner) {
        this.sys(s.id, `killing ${owner.name} (PID ${owner.pid}) that holds port ${port}`);
        await killTree(owner.pid);
        if (!(await waitFor(async () => !(await isPortOpen(port)), 10000))) {
          throw new Error(`Port ${port} is still in use`);
        }
      }
    }
    return alive();
  }

  autoKill() {
    return this.config.settings.autoKillPortConflicts !== false;
  }

  // Leftover instances that are not holding a configured port: stray ngrok agents
  // and the PID a dev server named in its "already running" message.
  async findExtraLeftovers(s) {
    const found = [];
    if (s.ngrokApi) {
      for (const p of await findProcessesByName('ngrok')) found.push({ ...p, reason: 'leftover ngrok agent' });
    }
    const hint = this.staleHints.get(s.id);
    if (hint) {
      const p = await findProcessById(hint);
      if (p) found.push({ ...p, reason: 'instance reported as already running' });
    }
    return found;
  }

  async killProcesses(id, list) {
    const killed = [];
    for (const p of list) {
      if (!p.pid || p.pid === process.pid || killed.some((k) => k.pid === p.pid)) continue;
      this.sys(id, `killing ${p.name} (PID ${p.pid}): ${p.reason}`);
      await killTree(p.pid);
      killed.push(p);
    }
    this.staleHints.delete(id);
    return killed;
  }

  // Manual "kill leftovers": frees configured ports and removes stray instances of this service.
  async killLeftovers(id) {
    const s = this.find(id);
    if (!s || s.type === 'ollama') return [];
    if (this.isActive(id)) throw new Error('Stop the service first');
    const list = [];
    for (const port of this.conflictPorts(s)) {
      if (!(await isPortOpen(port))) continue;
      const owner = await findPortOwner(port);
      if (owner) list.push({ ...owner, reason: `holds port ${port}` });
    }
    list.push(...(await this.findExtraLeftovers(s)));
    const killed = await this.killProcesses(id, list);
    if (!killed.length) this.sys(id, 'no leftover processes found');
    if (this.state.get(id).status === 'error') this.setState(id, { status: 'stopped', message: '' });
    return killed;
  }

  async startProcess(s, alive) {
    if (!fs.existsSync(s.cwd)) throw new Error(`Folder not found: ${s.cwd}`);
    if (this.autoKill()) await this.killProcesses(s.id, await this.findExtraLeftovers(s));
    if (!alive()) return;
    this.staleHints.delete(s.id);
    if (!(await this.resolvePortConflict(s, alive))) return;

    const env = { ...process.env, FORCE_COLOR: '1', ...(s.env || {}) };
    if (s.port) env.PORT = String(s.port);
    this.sys(s.id, `$ ${s.command}   \x1b[90m(${s.cwd})\x1b[0m`);
    const child = spawn(s.command, { cwd: s.cwd, shell: true, env, windowsHide: true });
    this.procs.set(s.id, child);
    this.setState(s.id, { status: 'running', pid: child.pid });

    const onData = (d) => this.onOutput(s, d.toString());
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => this.fail(s.id, err));
    child.on('exit', (code) => {
      if (this.procs.get(s.id) !== child) return;
      this.procs.delete(s.id);
      const wasStopping = this.state.get(s.id)?.status === 'stopping';
      this.sys(s.id, `process exited (code ${code})`);
      if (wasStopping || code === 0) this.setState(s.id, { status: 'stopped', pid: null, message: '' });
      else if (this.autoKill() && this.staleHints.has(s.id) && !this.retried.has(s.id)) {
        // The app reported another instance already running: kill it and retry once.
        this.retried.add(s.id);
        this.setState(s.id, { status: 'stopped', pid: null, message: '' });
        this.findExtraLeftovers(s)
          .then((list) => this.killProcesses(s.id, list))
          .then(() => this.start(s.id))
          .catch((err) => this.fail(s.id, err));
      } else {
        this.setState(s.id, { pid: null });
        this.fail(s.id, `Exited with code ${code}`);
      }
    });
    this.watchReady(s, child);
  }

  onOutput(s, text) {
    this.appendLog(s.id, text);
    const plain = text.replace(ANSI, '');
    const hint = plain.match(STALE_PID_HINT);
    if (hint) this.staleHints.set(s.id, Number(hint[1]));
    if (s.ngrokApi || this.state.get(s.id)?.port) return;
    const match = plain.match(LOCAL_URL_PORT);
    if (match) this.setState(s.id, { port: Number(match[1]) });
  }

  async watchReady(s, child) {
    const stillRunning = () => this.procs.get(s.id) === child && this.state.get(s.id)?.status === 'running';
    while (stillRunning()) {
      if (s.ngrokApi) {
        const url = await this.ngrokUrl(s.ngrokApi);
        if (url && stillRunning()) {
          this.sys(s.id, `public URL: ${url}`);
          this.retried.delete(s.id);
          this.setState(s.id, { status: 'ready', url });
        }
      } else {
        const port = s.port || this.state.get(s.id).port;
        if (port && (await isPortOpen(port)) && stillRunning()) {
          this.retried.delete(s.id);
          this.setState(s.id, { status: 'ready', port });
        }
      }
      await sleep(1000);
    }
  }

  async ngrokUrl(api) {
    try {
      const res = await fetch(api, { signal: AbortSignal.timeout(1500) });
      const { tunnels = [] } = await res.json();
      const tunnel = tunnels.find((t) => t.public_url?.startsWith('https')) || tunnels[0];
      return tunnel?.public_url || null;
    } catch {
      return null;
    }
  }

  // ---- ollama ------------------------------------------------------------

  async ollamaUp(host) {
    try {
      const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ollamaModelLoaded(host, model) {
    try {
      const res = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(1500) });
      const { models = [] } = await res.json();
      return models.some((m) => [m.name, m.model].some((n) => n === model || n === `${model}:latest`));
    } catch {
      return false;
    }
  }

  async startOllama(s, alive) {
    const host = s.host || DEFAULT_OLLAMA_HOST;
    const port = Number(new URL(host).port) || 11434;
    this.setState(s.id, { status: 'starting' });

    if (await this.ollamaUp(host)) {
      this.sys(s.id, `Ollama server already running at ${host}`);
      this.setState(s.id, { external: !this.procs.has(s.id) });
    } else {
      this.sys(s.id, '$ ollama serve');
      const child = spawn('ollama', ['serve'], { env: process.env, windowsHide: true });
      this.procs.set(s.id, child);
      this.setState(s.id, { pid: child.pid, external: false });
      const onData = (d) => this.appendLog(s.id, d.toString());
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => this.fail(s.id, err));
      child.on('exit', (code) => {
        if (this.procs.get(s.id) !== child) return;
        this.procs.delete(s.id);
        this.sys(s.id, `ollama serve exited (code ${code})`);
        if (['stopping', 'stopped'].includes(this.state.get(s.id)?.status)) return;
        this.setState(s.id, { pid: null });
        this.fail(s.id, `ollama serve exited with code ${code}`);
      });
      if (!(await waitFor(() => this.ollamaUp(host), 30000))) throw new Error('Ollama server did not start within 30s');
    }
    if (!alive()) return;

    if (s.model) {
      this.sys(s.id, `loading model ${s.model} (kept in memory until stopped)...`);
      this.setState(s.id, { message: `Loading ${s.model}...` });
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: s.model, keep_alive: -1 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) throw new Error(`Cannot load ${s.model}: ${body.error || `HTTP ${res.status}`}`);
      if (!alive()) return;
      this.sys(s.id, `model ${s.model} loaded, API: ${host}`);
    }
    this.setState(s.id, { status: 'ready', port, url: null, message: s.model ? `${s.model} loaded` : '' });
  }

  async stopOllama(s) {
    const host = s.host || DEFAULT_OLLAMA_HOST;
    this.setState(s.id, { status: 'stopping' });
    if (s.model && (await this.ollamaUp(host))) {
      try {
        await fetch(`${host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: s.model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10000),
        });
        this.sys(s.id, `model ${s.model} unloaded`);
      } catch {
        // Server went away meanwhile.
      }
    }
    const child = this.procs.get(s.id);
    if (child) {
      await killTree(child.pid);
      this.procs.delete(s.id);
      this.sys(s.id, 'ollama serve stopped');
    } else if (this.state.get(s.id).external) {
      this.sys(s.id, 'server was started outside Dev Launcher, left running');
    }
    this.setState(s.id, { status: 'stopped', pid: null, port: null, external: false, message: '' });
  }

  // Keeps Ollama status honest when the server or model changes outside the app.
  async probe() {
    for (const s of this.config.services.filter((x) => x.type === 'ollama')) {
      const st = this.state.get(s.id);
      if (!['stopped', 'running', 'ready', 'error'].includes(st.status)) continue;
      const host = s.host || DEFAULT_OLLAMA_HOST;
      const port = Number(new URL(host).port) || 11434;
      const owned = this.procs.has(s.id);
      if (!(await this.ollamaUp(host))) {
        if (st.status !== 'stopped' && st.status !== 'error') {
          this.setState(s.id, { status: 'stopped', port: null, external: false, message: 'Server not running' });
        }
        continue;
      }
      const loaded = !s.model || (await this.ollamaModelLoaded(host, s.model));
      if (this.state.get(s.id).status !== st.status) continue;
      if (loaded) {
        this.setState(s.id, { status: 'ready', port, external: !owned, message: s.model ? `${s.model} loaded` : '' });
      } else {
        this.setState(s.id, { status: 'running', port, external: !owned, message: `Server up, ${s.model} not loaded` });
      }
    }
  }
}

module.exports = { ServiceManager };
