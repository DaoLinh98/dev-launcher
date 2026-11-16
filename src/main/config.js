const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'default-services.json');
const DEFAULT_SETTINGS = { openAtLogin: false, startAllOnLaunch: false, startMinimized: false, dependencyTimeoutSec: 90, autoKillPortConflicts: true };
const DEFAULT_DOCKER = {
  enabled: true,
  desktopPath: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  autoStartContainers: [],
};
const TYPES = new Set(['process', 'ollama']);

function configPath(app) {
  return path.join(app.getPath('userData'), 'services.json');
}

function validate(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Config must be a JSON object');
  if (!Array.isArray(cfg.services)) throw new Error('"services" must be an array');

  const ids = new Set();
  cfg.services.forEach((s, i) => {
    if (!s || typeof s.id !== 'string' || !s.id.trim()) throw new Error(`services[${i}]: "id" is required`);
    if (ids.has(s.id)) throw new Error(`Duplicate service id "${s.id}"`);
    ids.add(s.id);
    const type = s.type || 'process';
    if (!TYPES.has(type)) throw new Error(`${s.id}: unknown type "${type}" (use "process" or "ollama")`);
    if (type === 'process' && (!s.cwd || !s.command)) throw new Error(`${s.id}: "cwd" and "command" are required`);
    if (s.port != null && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) {
      throw new Error(`${s.id}: "port" must be a number between 1 and 65535`);
    }
  });

  const edges = new Map();
  for (const s of cfg.services) {
    const deps = [...(s.dependsOn || []), ...(s.startAfter || [])];
    for (const dep of deps) {
      if (dep === s.id) throw new Error(`${s.id}: cannot depend on itself`);
      if (!ids.has(dep)) throw new Error(`${s.id}: unknown dependency "${dep}"`);
    }
    edges.set(s.id, deps);
  }

  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle involving "${id}"`);
    visiting.add(id);
    edges.get(id).forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  ids.forEach(visit);

  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  cfg.docker = { ...DEFAULT_DOCKER, ...(cfg.docker || {}) };
  return cfg;
}

function load(app) {
  const file = configPath(app);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fs.readFileSync(DEFAULT_FILE, 'utf8'));
  }
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function readText(app) {
  return fs.readFileSync(configPath(app), 'utf8');
}

// Validates before writing so a broken config never reaches disk.
function saveText(app, text) {
  const cfg = validate(JSON.parse(text));
  fs.writeFileSync(configPath(app), text);
  return cfg;
}

module.exports = { configPath, load, readText, saveText };
